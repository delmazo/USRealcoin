import axios from 'axios'
import {
  Account,
  Asset,
  Keypair,
  Network,
  Operation,
  Server as HorizonServer,
  TransactionBuilder,
  StrKey
} from 'stellar-sdk'

export const TransactionReceivedEvent = 'transaction_received'
export const AccountCreatedEvent = 'account_created'
export const TrustLinesCreatedEvent = 'trust_lines_created'
export const AccountCreditedEvent = 'account_credited'
export const PurchasedEvent = 'purchased'
export const ErrorEvent = 'error'

const ProtocolVersion = 1

const ChainBitcoin = 'bitcoin'
const ChainEthereum = 'ethereum'

export class Session {
  constructor(params, horizonOpts) {
    this._checkParams(params)
    this.params = params
    this.horizon = new HorizonServer(this.params.horizonURL, horizonOpts)
    if (params.network === 'test') {
      Network.useTestNetwork()
    } else {
      Network.usePublicNetwork()
    }
    this.started = false
  }

  startBitcoin(onEvent) {
    return this._start(ChainBitcoin, onEvent)
  }

  startEthereum(onEvent) {
    return this._start(ChainEthereum, onEvent)
  }

  _start(chain, onEvent) {
    if (this.started) {
      throw new Error('Session already started')
    }
    this.started = true
    this.keypair = Keypair.random()

    return new Promise((resolve, reject) => {
      axios.post(`${this.params.bifrostURL}/generate-${chain}-address`, `stellar_public_key=${this.keypair.publicKey()}`)
        .then(response => {
          if (response.data.chain !== chain) {
            return reject('Invalid chain')
          }

          if (response.data.protocol_version !== ProtocolVersion) {
            return reject('Invalid protocol_version. Make sure Bifrost server is using the same protocol version.')
          }

          const address = response.data.address
          resolve({
            address: address,
            keypair: this.keypair
          })

          const source = new EventSource(`${this.params.bifrostURL}/events?stream=${address}`)
          source.addEventListener('transaction_received', e => onEvent(TransactionReceivedEvent), false)
          source.addEventListener('account_created', e => this._onAccountCreated(onEvent, chain), false)
          source.addEventListener('account_credited', e => {
            this._onAccountCredited(onEvent, JSON.parse(e.data))
            source.close()
          }, false)
          source.addEventListener('error', e => console.error(e), false)
        })
        .catch(reject)
    })
  }

  _onAccountCreated(onEvent, chain) {
    onEvent(AccountCreatedEvent)

    let chainAssetCode
    if (chain === ChainBitcoin) {
      chainAssetCode = 'BTC'
    } else if (chain === ChainEthereum) {
      chainAssetCode = 'ETH'
    }

    // Create trust lines
    this.horizon.loadAccount(this.keypair.publicKey())
      .then(sourceAccount => {
        this._onAccountCreatedRecoveryTransactions(sourceAccount.sequenceNumber(), chainAssetCode)

        const transaction = new TransactionBuilder(sourceAccount)
          .addOperation(Operation.changeTrust({
            asset: new Asset(chainAssetCode, this.params.issuingPublicKey)
          }))
          .addOperation(Operation.changeTrust({
            asset: new Asset(this.params.assetCode, this.params.issuingPublicKey)
          }))
          .build()
        transaction.sign(this.keypair)
        return this.horizon.submitTransaction(transaction)
      }).then(function() {
        onEvent(TrustLinesCreatedEvent)
      })
      .catch(e => onEvent(ErrorEvent, e))
  }

  _onAccountCredited(onEvent, {
    assetCode,
    amount
  }) {
    onEvent(AccountCreditedEvent)
    // Buy asset
    this.horizon.loadAccount(this.keypair.publicKey())
      .then(sourceAccount => {
        this._onAccountCreditedRecoveryTransactions(sourceAccount.sequenceNumber(), assetCode, amount)

        if (this.params.preSaleMode) {
          return
        }

        const transaction = new TransactionBuilder(sourceAccount)
          .addOperation(Operation.manageOffer({
            selling: new Asset(assetCode, this.params.issuingPublicKey),
            buying: new Asset(this.params.assetCode, this.params.issuingPublicKey),
            amount: amount,
            price: this.params.price
          }))
          .build()
        transaction.sign(this.keypair)
        return this.horizon.submitTransaction(transaction)
      })
      .then(() => this.horizon.loadAccount(this.keypair.publicKey()))
      .then(account => {
        this._onPurchasedRecoveryTransactions(account)
        onEvent(PurchasedEvent)
      })
      .catch(e => onEvent(ErrorEvent, e))
  }

  _onAccountCreatedRecoveryTransactions(currentSequenceNumber, chainAssetCode) {
    const account = new Account(this.keypair.publicKey(), currentSequenceNumber)

    // Fail after account creation and before change_trust
    let transaction = new TransactionBuilder(account)
      .addOperation(Operation.accountMerge({
        destination: this.params.issuingPublicKey
      }))
      .build()
    transaction.sign(this.keypair)
    this._submitRecovery(transaction)

    // Fail after change_trust and before BTC/ETH receive
    transaction = new TransactionBuilder(account)
      .addOperation(Operation.changeTrust({
        asset: new Asset(chainAssetCode, this.params.issuingPublicKey),
        limit: '0'
      }))
      .addOperation(Operation.changeTrust({
        asset: new Asset(this.params.assetCode, this.params.issuingPublicKey),
        limit: '0'
      }))
      .addOperation(Operation.accountMerge({
        destination: this.params.issuingPublicKey
      }))
      .build()
    transaction.sign(this.keypair)
    this._submitRecovery(transaction)
  }

  _onAccountCreditedRecoveryTransactions(currentSequenceNumber, chainAssetCode, amount) {
    // Fail after change_trust and BTC/ETH received. We're creating two transactions:
    // - First, if c operation wasn't even sent.
    // - Second, if _onAccountCreditedRecoveryTransactions operation failed.
    const account = new Account(this.keypair.publicKey(), currentSequenceNumber)
    for (let i = 0; i < 2; i++) {
      const transaction = new TransactionBuilder(account)
        .addOperation(Operation.payment({
          destination: this.params.issuingPublicKey,
          asset: new Asset(chainAssetCode, this.params.issuingPublicKey),
          amount: amount
        }))
        .addOperation(Operation.changeTrust({
          asset: new Asset(chainAssetCode, this.params.issuingPublicKey),
          limit: '0'
        }))
        .addOperation(Operation.changeTrust({
          asset: new Asset(this.params.assetCode, this.params.issuingPublicKey),
          limit: '0'
        }))
        .addOperation(Operation.accountMerge({
          destination: this.params.issuingPublicKey
        }))
        .build()
      transaction.sign(this.keypair)
      this._submitRecovery(transaction)
    }
  }

  _onPurchasedRecoveryTransactions(account) {
    const transactionBuilder = new TransactionBuilder(account)

    // Send back assets and remove trust lines
    for (const balance of account.balances) {
      if (balance.asset_type === 'native') {
        continue
      }

      if (balance.balance !== '0.0000000') {
        transactionBuilder.addOperation(Operation.payment({
          destination: this.params.issuingPublicKey,
          asset: new Asset(balance.asset_code, balance.asset_issuer),
          amount: balance.balance
        }))
      }

      transactionBuilder.addOperation(Operation.changeTrust({
        asset: new Asset(balance.asset_code, balance.asset_issuer),
        limit: '0'
      }))
    }

    transactionBuilder.addOperation(Operation.accountMerge({
      destination: this.params.issuingPublicKey
    }))

    const transaction = transactionBuilder.build()
    transaction.sign(this.keypair)
    this._submitRecovery(transaction)
  }

  _submitRecovery(transaction) {
    const envelope = transaction.toEnvelope().toXDR().toString('base64')
    const envelopeEncoded = encodeURIComponent(envelope)
    return axios.post(`${this.params.bifrostURL}/recovery-transaction`, `transaction_xdr=${envelopeEncoded}`)
  }

  _checkParams(params) {
    if (params === undefined) {
      throw new Error('params not provided')
    }

    if (['live', 'test'].indexOf(params.network) === -1) {
      throw new Error('Invalid params.network')
    }

    if (!StrKey.isValidEd25519PublicKey(params.issuingPublicKey)) {
      throw new Error('Invalid params.issuingPublicKey')
    }

    const requiredParams = ['bifrostURL', 'horizonURL', 'assetCode', 'price']
    for (const param of requiredParams) {
      if (typeof params[param] !== 'string') {
        throw new Error(`params.${param} required and must be of type 'string'`)
      }
    }
  }
}
