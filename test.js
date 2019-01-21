// from the gekko repo (make sure you have deps installed
// inside the exchange folder).
const Broker = require('./exchange/gekkoBroker');
// or from NPM
// const Broker = require('gekko-broker');

const bitso = new Broker({
    currency: 'MXN',
    asset: 'BTC',
    private: true,

    exchange: 'bitso',
    key: '', // add your API key
    secret: '' // add your API secret
});

bitso.portfolio.setBalances(console.log);

const type = 'sticky';
const amount = 0.0001;
const side = 'sell';
const limit = 100000;

const order = bitso.createOrder(type, side, amount, { limit });

order.on('statusChange', status => console.log(status));
order.on('filled', result => console.log(result));
order.on('completed', () => {
    order.createSummary(summary => console.log)
});
