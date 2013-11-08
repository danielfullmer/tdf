//=============================================================================
//  Module Dependencies
//=============================================================================

var mongoose = require('mongoose'),
    Agent = mongoose.model('Agent'),
    Crypto = require('crypto'),
    request = require('request'),
    csv = require('csv'),
    _ = require('underscore');

//=============================================================================
//  Helper Functions
//=============================================================================

/**
 * Creates a random ascii key of the specified length
 */
var randomAscii = function(len){
    // Derived from
    // http://kun.io/blog/42051818404/Node.js:-Creating-a-Random-String
    var bytes = Crypto.randomBytes(len);
    var i;
    var verificationCode = '';

    // loop through each byte
    for (i=0; i < bytes.length; i++) {
        var c = bytes[i]; // the character in range 0 to 255
        var c2 = Math.floor(c / 10.24); // transform to range 0-25 and round
                                        // down
        var c3 = c2 + 97; // ASCII a to z is 97 to 122
        // now convert the transformed character code to its string
        // value and append to the verification code
        verificationCode += String.fromCharCode(c3);
    }
    return verificationCode;
};

/*var get_security_price = function(symbol, method) {
    if (symbol === 'notasymbol') {
        throw {
            'msg': 'Unknown security: ' + symbol + '.',
            'code': 4
        };
    }
    if (symbol === 'cash') {
        throw {
            'msg': 'Cannot trade cash. Please trade securities.',
            'code': 5
        };
    }
    if (method === 'sell') {
        return 110;
    }
    if (method === 'buy') {
        return 100;
    }
};*/

/**
 * Gets a table of quotes for the given symbols and executes the callback
 * on the result.
 *
 * http://greenido.wordpress.com/2009/12/22/yahoo-finance-hidden-api/
 */
var getQuotes = function(req, res, symbols, cb) {
    var yUrl = 'http://download.finance.yahoo.com/d/quotes.csv' +
               '?f=sbal1&s=';

    var symbol_str = _.reduce(symbols, function(memo, symbol) {
        var pre = '';
        if (symbol.length) {
            pre = '+';
        }
        return memo + pre + symbol;
    });
    var url = yUrl + symbol_str;
    console.log(JSON.stringify(symbols));
    console.log(url);
    request(url, function(error, request, body) {
        if (error) {
            cb(req, res, error, null);
        }
        else {
            csv().from.string(body).to.array(function(quotesarray) {
                var quotes = {};
                _.each(quotesarray, function(quote) {
                    quotes[_.first(quote)] = {
                        'ask': quote[1],
                        'bid': quote[2],
                        'last': quote[3]
                    };
                });
                cb(req, res, null, quotes);
            });
        }
    });
};

/**
 * Returns the portfolio value.
 *
 * Assumes quotes has a symbol for everything in the current composition.
 */
var portfolioValue = function(composition, quotes, negative_only) {
    var value = 0;
    var curr_value = 0;
    _.each(composition, function(quantity, symbol) {
        if (symbol === 'cash') {
            curr_value = quantity;
        }
        else {
            // TODO error check symbol existing in quotes
            // TODO error check symbol has a quantity
            // TODO tie in value computation with admin (don't necessarily be
            //      bid
            curr_value = (quotes[symbol].bid * quantity);
        }

        if (!negative_only || curr_value < 0) {
            value += curr_value;
        }
    });
    return value;
};

//=============================================================================
//  Exports: CRUD
//=============================================================================

/**
 * Find agent by id
 */
exports.agent = function(req, res, next, id) {
    Agent.load(id, function(err, agent) {
        if (err) {
            return next(err);
        }
        if (!agent) {
            return next(new Agent('Failed to load agent ' + id));
        }
        req.agent = agent;
        next();
    });
};

/**
 * Create an agent
 */
exports.create = function(req, res) {
    var agent = new Agent(req.body);
    agent.apikey = randomAscii(32);
    agent.user = req.user;

    agent.save(function(err) {
        if (err) {
            return res.send('users/signup', {
                errors: err.errors,
                agent: agent
            });
        }
        res.jsonp(agent);
    });
};

/**
 * Update an agent
 */
exports.update = function(req, res) {
    var agent = req.agent;
    agent = _.extend(agent, _.omit(req.body, 'apikey'));

    agent.save(function(/*err*/) {
        res.jsonp(agent);
    });
};

/**
 * Delete an agent
 */
exports.destroy = function(req, res) {
    var agent = req.agent;

    agent.remove(function(err) {
        if (err) {
            res.render('error', {
                status: 500
            });
        }
        else {
            res.jsonp(agent);
        }
    });
};

/**
 * Show an agent
 */
exports.show = function(req, res) {
    var agent = req.agent.toJSON();
    var user = req.user;

    if (user === undefined || !user._id.equals(agent.user._id)) {
        agent = _.omit(agent, 'portfolio', 'apikey');
        agent.status = _.omit(agent.status, 'current_portfolio');
    }
    res.jsonp(agent);
};

/**
 * Gives the current status (most recent portfolio composition) of the
 * agent.
 *
 * TODO
 */
exports.current_status = function(req, res) {
    var agent = req.agent;
    var current_portfolio = _.last(agent.portfolio);
    res.jsonp(current_portfolio);
};

/**
 * List of agents
 */
exports.all = function(req, res) {
    Agent.find().sort('-created').populate('user', 'name username').
        populate('league', 'name startCash').exec(function (err, agents) {

        if (err) {
            res.render('error', {
                status: 500
            });
        }
        else {
            res.jsonp(agents);
        }
    });
};

/**
 * Regenerates a new random api key for the user.
 */
exports.resetapikey = function(req, res) {
    var agent = req.agent;
    agent.apikey = randomAscii(32);
    agent.save(function (/*err*/) {
        res.jsonp(agent);
    });
};

//=============================================================================
//  Exports: Trading System
//=============================================================================


/**
 * Real codes:
 *  1. Could not connect to Yahoo finance
 */
var __execute_trade = function(req, res, error, quotes) {
    try {
        if (error) {
            throw {
                'msg': 'Error connecting to Yahoo Finance',
                'code': 1
            };
        }

        var trade = req.body.trade || req.body;
        var agent = req.agent;
        var last_portfolio = _.last(agent.portfolio);
        var curr_composition;

        if (last_portfolio === undefined) {
            curr_composition = {
                'cash': req.agent.league.startCash
            };
        }
        else {
            curr_composition = _.clone(last_portfolio.composition);
        }

        var portfolio_value = portfolioValue(curr_composition, quotes, false);
        var negative_value = portfolioValue(curr_composition, quotes, true);

        //--------------
        // Sell first...
        //--------------

        _.each(trade.sell, function(security) {
            // TODO tie bid/ask to admin
            // TODO error checking of non-existent
            var price = quotes[security.s].bid;
            var buyPrice = quotes[security.s].ask;
            var profit = price * security.q;
            var shortSellLimit = req.agent.league.shortSellLimit;

            if (curr_composition[security.s] === undefined) {
                if (shortSellLimit === 0) {
                    throw {
                        'msg': 'Cannot sell a security that you do not own.',
                        'code': 1
                    };
                }
                else if (shortSellLimit*(portfolio_value + profit -
                                         buyPrice * security.q) <
                         Math.abs(negative_value - buyPrice * security.q)) {
                    throw {
                        'msg': 'This trade is invalid, it would cause you ' +
                               'to pass the short sell limit for this league.',
                        'code': 1
                    };
                }
            }

            curr_composition.cash += profit;
            curr_composition[security.s] -= security.q;

            if (curr_composition[security.s] < 0) {
                if (shortSellLimit === 0) {
                    throw {
                        'msg': 'Cannot sell a security that you do not own.',
                        'code': 1
                    };
                }
                else if (shortSellLimit*(portfolio_value + profit -
                                         buyPrice * security.q) <
                         Math.abs(negative_value - buyPrice * security.q)) {
                    throw {
                        'msg': 'This trade is invalid, it would cause you ' +
                               'to pass the short sell limit for this league.',
                        'code': 1
                    };
                }
            }

            if (curr_composition[security.s] === 0) {
                delete curr_composition[security.s];
            }

        });

        //---------
        // Then buy
        //---------

        _.each(trade.buy, function(security) {
            // TODO tie in admin bid/ask
            // TODO error checking
            var price = quotes[security.s].ask;
            var sell_price = quotes[security.s].bid;
            var cost = price * security.q;
            var curr_quantity = curr_composition[security.s] || 0;
            var leverageLimit = req.agent.league.leverageLimit;
            curr_composition.cash -= cost;
            curr_composition[security.s] = curr_quantity + security.q;

            if (curr_composition.cash < 0) {
                if(leverageLimit === 0) {
                    throw {
                        'msg': 'Not enough cash to purchase desired ' +
                               'securities.',
                        'code': 3
                    };
                }
                else if (leverageLimit*(portfolio_value + cost - sell_price) <
                         Math.abs(negative_value - sell_price * security.q)) {
                    throw {
                        'msg': 'This trade is invalid, it would cause you ' +
                               'to pass the leverage limit for this league.',
                        'code': 3
                    };
                }
            }
        });

        //----------------------
        // Save changes to agent
        //----------------------

        agent.portfolio.push({composition: curr_composition});
        agent.save(function () {
            res.jsonp(agent);
        });
    }
    catch (err) {
        //-------------------------
        // An error was encountered
        //-------------------------

        res.jsonp({
            error: err
        });
    }
};

/**
 * Allow a trade to be made
 *
 * If trade is successful, responds with the new agent
 * Otherwise, responds with {error: {'msg': <message>, 'code': <code>}}
 *
 * Error codes are as follows:
 *  1. Attempted to sell a security that does not own
 *  2. Attempted to sell more of a security than already owns
 *  3. Attempted to buy more than has cash to purchase
 *  4. Attempted to buy or sell on a nonexistant security (symbol doesn't
 *     match any known security)
 *  5. Attempted to trade cash
 */
exports.trade = function(req, res) {

    var trade = req.body.trade || req.body;  // Depending on source of data

    // Filter out trades with zero quantity
    trade.buy = _.filter(trade.buy, function(security) {
        return security.q !== 0;
    });
    trade.sell = _.filter(trade.sell, function(security) {
        return security.q !== 0;
    });

    // Get list of all unique trade symbols
    var buysymbols = _.map(trade.buy, function(security) {
        return security.s;
    });
    var sellsymbols = _.map(trade.sell, function(security) {
        return security.s;
    });
    var symbols = _.union(buysymbols, sellsymbols);

    // Add symbols from current composition
    var last_portfolio = _.last(req.agent.portfolio).composition;
    if (last_portfolio !== undefined) {
        var cashless = _.omit(last_portfolio, 'cash');
        var portfolio_symbols = _.map(cashless, function(security, symbol) {
            return symbol;
        });
        symbols = _.union(symbols, portfolio_symbols);
        // TODO what happens if a portfolio has a security that yahoo does not?
    }

    // Trade
    getQuotes(req, res, symbols, __execute_trade);

    /*var last_portfolio = _.last(req.agent.portfolio);
    var curr_composition;
    var curr_cash;

    if (last_portfolio === undefined) {
        curr_composition = {
            'cash': req.agent.league.startCash
        };
    }
    else {
        curr_composition = _.clone(last_portfolio.composition);
        curr_cash = curr_composition.cash;
    }

    // Find the value of the current portfolio
    var portfolio_value = 0;
    var negative_value = 0;
    for (var x in curr_composition) {
        if (x === 'cash') {
            portfolio_value += parseInt(curr_composition[x]);
            if (parseInt(curr_composition[x]) < 0) {
                negative_value += parseInt(curr_composition[x]);
            }
        }
        else {
            var security_value;
            if (parseInt(curr_composition[x]) > 0) {
                security_value = get_security_price(x, 'sell');
            }
            else {
                security_value = get_security_price(x, 'buy');
                negative_value += security_value;
            }
            portfolio_value += parseInt(curr_composition[x]*security_value);
        }
    }

    try {
        //--------------
        // Sell first...
        //--------------

        _.each(trade.sell, function(security) {
            var price = get_security_price(security.s, 'sell');
            var buyPrice = get_security_price(security.s, 'buy');
            var profit = price * security.q;
            var shortSellLimit = req.agent.league.shortSellLimit;

            if (curr_composition[security.s] === undefined) {
                if (shortSellLimit === 0) {
                    throw {
                        'msg': 'Cannot sell a security that you do not own.',
                        'code': 1
                    };
                }
                else if (shortSellLimit*(portfolio_value + profit -
                                         buyPrice * security.q) <
                         Math.abs(negative_value - buyPrice * security.q)) {
                    throw {
                        'msg': 'This trade is invalid, it would cause you ' +
                               'to pass the short sell limit for this league.',
                        'code': 1
                    };
                }
            }

            curr_composition.cash += profit;
            curr_composition[security.s] -= security.q;

            if (curr_composition[security.s] < 0) {
                if (shortSellLimit === 0) {
                    throw {
                        'msg': 'Cannot sell a security that you do not own.',
                        'code': 1
                    };
                }
                else if (shortSellLimit*(portfolio_value + profit -
                                         buyPrice * security.q) <
                         Math.abs(negative_value - buyPrice * security.q)) {
                    throw {
                        'msg': 'This trade is invalid, it would cause you ' +
                               'to pass the short sell limit for this league.',
                        'code': 1
                    };
                }
            }

            if (curr_composition[security.s] === 0) {
                delete curr_composition[security.s];
            }

        });

        //---------
        // Then buy
        //---------

        _.each(trade.buy, function(security) {
            var price = get_security_price(security.s, 'buy');
            var sell_price = get_security_price(security.s, 'sell');
            var cost = price * security.q;
            var curr_quantity = curr_composition[security.s] || 0;
            var leverageLimit = req.agent.league.leverageLimit;
            curr_composition.cash -= cost;
            curr_composition[security.s] = curr_quantity + security.q;

            if (curr_composition.cash < 0) {
                if(leverageLimit === 0) {
                    throw {
                        'msg': 'Not enough cash to purchase desired ' +
                               'securities.',
                        'code': 3
                    };
                }
                else if (leverageLimit*(portfolio_value + cost - sell_price) <
                         Math.abs(negative_value - sell_price * security.q)) {
                    throw {
                        'msg': 'This trade is invalid, it would cause you ' +
                               'to pass the leverage limit for this league.',
                        'code': 3
                    };
                }
            }
        });

        //----------------------
        // Save changes to agent
        //----------------------

        agent.portfolio.push({composition: curr_composition});
        agent.save(function () {
            res.jsonp(agent);
        });
    }
    catch (err) {

        //-------------------------
        // An error was encountered
        //-------------------------

        res.jsonp({
            error: err
        });
    }*/
};

/**
 * Resets all trades made by the agent, returning agent.portfolio to its
 * initial state of [].
 *
 * TODO: Check if league is in competition; if so, don't allow reset.
 */
exports.reset = function(req, res) {
    var agent = req.agent;

    agent.cash = req.agent.league.startCash;
    agent.portfolio = [];

    agent.save(function (/*err*/){
        res.jsonp(agent);
    });
};
