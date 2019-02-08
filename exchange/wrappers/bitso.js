const moment = require('moment');
const _ = require('lodash');

const Errors = require('../exchangeErrors');
const marketData = require('./bitso-markets.json');
const exchangeUtils = require('../exchangeUtils');
const retry = exchangeUtils.retry;
const scientificToDecimal = exchangeUtils.scientificToDecimal;

const BitsoClient = require('bitso-api');

const Trader = function (config) {
    _.bindAll(this, [
        'roundAmount',
        'roundPrice',
        'isValidPrice',
        'isValidLot'
    ]);

    this.key = "";
    this.secret = "";

    if (_.isObject(config)) {
        if (_.isString(config.key)) this.key = config.key;
        if (_.isString(config.secret)) this.secret = config.secret;
        this.currency = config.currency.toUpperCase();
        this.asset = config.asset.toUpperCase();
    }

    let recvWindow = 6000;
    if (config.optimizedConnection) {
        // there is a bug in binance's API
        // where some requests randomly take
        // over a second, this tells binance
        // to bail out after 500ms.
        //
        // As discussed in binance API
        // telegram. TODO add link.
        recvWindow = 500;
    }

    this.pair = this.asset.toLowerCase() + '_' + this.currency.toLowerCase();
    this.name = 'bitso';

    this.market = _.find(Trader.getCapabilities().markets, (market) => {
        return market.pair[0] === this.currency && market.pair[1] === this.asset;
    });

    this.bitso = new BitsoClient({
        key: this.key,
        secret: this.secret
    });

    if (config.key && config.secret) {
        // Note non standard func:
        //
        // On binance we might pay fees in BNB
        // if we do we CANNOT calculate feePercent
        // since we don't track BNB price (when we
        // are not trading on a BNB market).
        //
        // Though we can deduce feePercent based
        // on user fee tracked through `this.getFee`.
        // Set default here, overwrite in getFee.
        this.fee = 0.005;
        // Set the proper fee asap.
        this.getFee(_.noop);

        this.oldOrder = false;
    }
};

const recoverableErrors = [
    'SOCKETTIMEDOUT',
    'TIMEDOUT',
    'CONNRESET',
    'CONNREFUSED',
    'NOTFOUND',
    'Error -1021',
    'Response code 429',
    'Response code 5',
    'Response code 403',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    // getaddrinfo EAI_AGAIN api.binance.com api.binance.com:443
    'EAI_AGAIN',
    'ENETUNREACH'
];

const includes = (str, list) => {
    if (!_.isString(str))
        return false;

    return _.some(list, item => str.includes(item));
};

Trader.prototype.requestPublic = function (endpoint, params = {}, method, callback) {

    this.bitso[endpoint]({
        params,
        method: method,
        success: data => callback(null, data),
        error: data => callback(data)
    });
};

Trader.prototype.handleResponse = function (funcName, callback) {

    return (error, body) => {
        if (body && body.payload.code) {
            error = new Error(`Error ${body.code}: ${body.msg}`);
        }

        if (error) {

            var errorA;

            if (_.isString(error)) {
                error = new Error(error);
            }
            
            if(error.error == undefined){
                errorA = error.message;
            } else {
                errorA = error.error.message;
            }
            
            if (includes(errorA, recoverableErrors)) {
                errorA.notFatal = true;
                return callback(errorA);
            }

            if (funcName === 'cancelOrder' && error.message.includes('UNKNOWN_ORDER')) {
                console.log(new Date, 'cancelOrder', 'UNKNOWN_ORDER');
                // order got filled in full before it could be
                // cancelled, meaning it was NOT cancelled.
                return callback(false, { filled: true });
            }

            if (funcName === 'checkOrder' && errorA.includes('Order does not exist.')) {
                console.log(new Date, 'Bitso doesnt know this order, retrying up to 10 times..');
                error.error.retry = 10;
            }

            if (funcName === 'addOrder' && errorA.includes('exceeds available')) {
                console.log(new Date, 'insufficientFunds');
                //error.type = 'insufficientFunds';
                error.error.retry = 2;
                error.error.backoffDelay = 1000;
            }

            return callback(error.error);
        }

        return callback(undefined, body);
    };
};

Trader.prototype.getTrades = function (since, callback, descending) {
    const processResults = (err, data) => {
        if (err) return callback(err);

        var parsedTrades = [];
        _.each(
            data.payload,
            function (trade) {
                parsedTrades.push({
                    tid: trade.tid,
                    date: moment(trade.created_at).unix(),
                    price: parseFloat(trade.price),
                    amount: parseFloat(trade.amount),
                });
            },
            this
        );

        if (descending) callback(null, parsedTrades.reverse());
        else callback(undefined, parsedTrades);
    };

    var reqData = {
        book: this.pair,
    };

    if (since) {
        /* var endTs = moment(since)
            .add(1, 'h')
            .valueOf();
        var nowTs = moment().valueOf();

        reqData.startTime = moment(since).valueOf();
        reqData.endTime = endTs > nowTs ? nowTs : endTs; */
        var reqData = {
            book: this.pair,
            limit: 100
        };
    }

    //const fetch = cb => this.binance.aggTrades(reqData, this.handleResponse('getTrades', cb));
    const fetch = cb => this.requestPublic('trades', reqData, 'GET', this.handleResponse('getTrades', cb));
    retry(undefined, fetch, processResults);
};

Trader.prototype.getPortfolio = function (callback) {
    const setBalance = (err, data) => {
        if (err) return callback(err);

        data = data.payload.balances;

        const findAsset = item => item.currency === this.asset.toLowerCase();
        const assetAmount = parseFloat(_.find(data, findAsset).available);

        const findCurrency = item => item.currency === this.currency.toLowerCase();
        const currencyAmount = parseFloat(_.find(data, findCurrency).available);

        if (!_.isNumber(assetAmount) || _.isNaN(assetAmount)) {
            assetAmount = 0;
        }

        if (!_.isNumber(currencyAmount) || _.isNaN(currencyAmount)) {
            currencyAmount = 0;
        }

        const portfolio = [
            { name: this.asset, amount: assetAmount },
            { name: this.currency, amount: currencyAmount },
        ];

        return callback(undefined, portfolio);
    };

    const fetch = cb => this.requestPublic('balance', {}, 'GET', this.handleResponse('getPortfolio', cb));
    retry(undefined, fetch, setBalance);
};

Trader.prototype.getFee = function (callback) {

    // binance does NOT tell us whether the user is using BNB to pay
    // for fees, which means a discount (effectively lower fees)
    const handle = (err, data) => {
        if (err) {
            return callback(err);
        }

        data = data.payload.fees;

        const findAsset = item => item.book === this.pair;
        const basepoints = parseFloat(_.find(data, findAsset).maker_fee_decimal);

        /** Binance raw response
        { makerCommission: 10,
          takerCommission: 10,
          buyerCommission: 0,
          sellerCommission: 0,
          canTrade: true,
          canWithdraw: true,
          canDeposit: true,
          So to get decimal representation of fee we actually need to divide by 10000
        */
        // note non standard func, see constructor
        this.fee = basepoints;

        callback(undefined, this.fee);
    }

    const fetch = cb => this.requestPublic('fees', {}, 'GET', this.handleResponse('getFee', cb));
    retry(undefined, fetch, handle);
};

Trader.prototype.getTicker = function (callback) {
    const setTicker = (err, data) => {
        if (err)
            return callback(err);

        data = data.payload;

        if (!data)
            return callback(new Error(`Market ${this.pair} not found on Bitso`));

        var ticker = {
            ask: parseFloat(data.ask),
            bid: parseFloat(data.bid),
        };

        callback(undefined, ticker);
    };

    var params = { book: 'btc_mxn' };
    const handler = cb => this.requestPublic('ticker', params, 'GET', this.handleResponse('getTicker', cb));
    retry(undefined, handler, setTicker);
};

// Effectively counts the number of decimal places, so 0.001 or 0.234 results in 3
Trader.prototype.getPrecision = function (tickSize) {
    if (!isFinite(tickSize)) return 0;
    var e = 1, p = 0;
    while (Math.round(tickSize * e) / e !== tickSize) { e *= 10; p++; }
    return p;
};

Trader.prototype.round = function (amount, tickSize) {
    var precision = 100000000;
    var t = this.getPrecision(tickSize);

    if (Number.isInteger(t))
        precision = Math.pow(10, t);

    amount *= precision;
    amount = Math.floor(amount);
    amount /= precision;

    // https://gist.github.com/jiggzson/b5f489af9ad931e3d186
    amount = scientificToDecimal(amount);

    return amount;
};

Trader.prototype.roundAmount = function (amount) {
    return this.round(amount, this.market.minimalOrder.amount);
}

Trader.prototype.roundPrice = function (price) {
    return this.round(price, this.market.minimalOrder.price);
}

Trader.prototype.isValidPrice = function (price) {
    return price >= this.market.minimalOrder.price;
}

Trader.prototype.isValidLot = function (price, amount) {
    return amount * price >= this.market.minimalOrder.order;
}

Trader.prototype.outbidPrice = function (price, isUp) {
    let newPrice;

    if (isUp) {
        newPrice = price + this.market.minimalOrder.price;
    } else {
        newPrice = price - this.market.minimalOrder.price;
    }

    return this.roundPrice(newPrice);
}

Trader.prototype.addOrder = function (type, amount, price, callback) {
    const setOrder = (err, data) => {
        if (err) return callback(err);

        const txid = data.payload.oid;
        //console.log(txid);
        callback(undefined, txid);
    };

    const reqData = {
        book: this.pair,
        side: type,
        type: 'limit',
        major: amount,
        price: price,
    };

    console.log(reqData);

    const handler = cb => setTimeout(() => this.requestPublic('orders', reqData, 'POST', this.handleResponse('addOrder', cb)),1000);
    retry(undefined, handler, setOrder);
};

Trader.prototype.getOrder = function (order, callback) {
    const get = (err, data) => {
        if (err) return callback(err);

        let price = 0;
        let amount = 0;
        let date = moment(0);

        const fees = {};

        data = data.payload;

        if (!data.length) {
            return callback(new Error('Bitso did not return any trades'));
        }

        const trades = _.filter(data, t => {
            // note: the API returns a string after creating
            return t.oid == order;
        });

        if (!trades.length) {
            console.log('cannot find trades!', { order, list: data.map(t => t.oid).reverse() });

            params = {
                oid: order
            }
            this.requestPublic('orders/:oid:', params, 'GET', (err, resp) => {
                payload = resp.payload;
                console.log('couldnt find any trade for order, here is order:', { err, payload });

                //callback(new Error('Trades not found'));
                return
            });

            return;
        }

        _.each(trades, trade => {
            date = moment(trade.created_at);
            major = trade.side == 'buy' ? +trade.major : -trade.major;
            price = ((price * amount) + (+trade.price * major)) / (+major + amount);
            amount += major;

            if (fees[trade.fees_currency])
                fees[trade.fees_currency] += (+trade.fees_amount);
            else
                fees[trade.fees_currency] = (+trade.fees_amount);
        });

        let feePercent = this.fee;


        callback(undefined, { price, amount, date, fees, feePercent });
    }

    const reqData = {
        book: this.pair
    };

    const handler = cb => this.requestPublic("user_trades", reqData, 'GET', this.handleResponse('getOrder', cb));
    retry(undefined, handler, get);
};

Trader.prototype.buy = function (amount, price, callback) {
    this.addOrder('buy', amount, price, callback);
};

Trader.prototype.sell = function (amount, price, callback) {
    this.addOrder('sell', amount, price, callback);
};

Trader.prototype.checkOrder = function (order, callback) {

    const check = (err, data) => {
        if (err) {
            return callback(err);
        }

        data = data.payload[0];

        if (data.status === 'closed') {
            // binance responsed with order not found
            return callback(undefined, { executed: true, open: false });
        }

        const status = data.status;

        if (
            status === 'cancelled' ||
            status === 'REJECTED' ||
            // for good measure: GB does not
            // submit orders that can expire yet
            status === 'EXPIRED'
        ) {
            return callback(undefined, { executed: false, open: false });
        } else if (
            status === 'open' ||
            status === 'partial-fill' ||
            status === 'partially filled' ||
            status === 'queued'
        ) {
            return callback(undefined, { executed: false, open: true, filledAmount: +data.original_amount - +data.unfilled_amount });
        } else if (status === 'completed') {
            return callback(undefined, { executed: true, open: false })
        }

        console.log('what status?', status);
        throw status;
    };

    const reqData = {
        oid: order
    };

    const fetcher = cb => this.requestPublic('orders/:oid:', reqData, 'GET', this.handleResponse('checkOrder', cb));
    retry(undefined, fetcher, check);
};

Trader.prototype.cancelOrder = function (order, callback) {

    const cancel = (err, data) => {

        this.oldOrder = order;

        if (err) {
            return callback(err);
        }

        data = data.payload

        if (data && data.filled) {
            return callback(undefined, true);
        }

        return callback(undefined, false);

    };

    let reqData = {
        oid: order,
    };

    const fetcher = cb => this.requestPublic("orders/:oid:", reqData, 'DELETE', this.handleResponse('cancelOrder', cb));
    retry(undefined, fetcher, cancel);
};

Trader.getCapabilities = function () {
    return {
        name: 'Bitso',
        slug: 'bitso',
        currencies: marketData.currencies,
        assets: marketData.assets,
        markets: marketData.markets,
        requires: ['key', 'secret'],
        tid: 'tid',
        tradable: true,
        gekkoBroker: 0.6,
        limitedCancelConfirmation: true
    };
};

module.exports = Trader;
