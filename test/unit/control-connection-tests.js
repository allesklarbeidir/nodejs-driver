/*
 * Copyright DataStax, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";
const assert = require('assert');
const events = require('events');
const rewire = require('rewire');
const dns = require('dns');

const helper = require('../test-helper.js');
const ControlConnection = require('../../lib/control-connection');
const Host = require('../../lib/host').Host;
const utils = require('../../lib/utils');
const Metadata = require('../../lib/metadata');
const types = require('../../lib/types');
const errors = require('../../lib/errors');
const policies = require('../../lib/policies');
const clientOptions = require('../../lib/client-options');
const ProfileManager = require('../../lib/execution-profile').ProfileManager;

describe('ControlConnection', function () {
  describe('constructor', function () {
    it('should create a new metadata instance', function () {
      const cc = new ControlConnection(clientOptions.extend({}, helper.baseOptions));
      helper.assertInstanceOf(cc.metadata, Metadata);
    });
  });
  describe('#init()', function () {
    this.timeout(20000);
    let useLocalhost;
    let useIp6;

    before(function (done) {
      dns.resolve('localhost', function (err) {
        if (err) {
          helper.trace('localhost can not be resolved');
        }
        useLocalhost = !err;

        done();
      });
    });

    before(done => dns.resolve6('localhost', (err, addresses) => {
      useIp6 = !err && addresses.length > 0;
      done();
    }));

    function testResolution(CcMock, expectedHosts, expectedResolved, done) {
      if (typeof expectedResolved === 'function') {
        done = expectedResolved;
        expectedResolved = expectedHosts;
      }

      const state = {};
      const cc = new CcMock(clientOptions.extend({ contactPoints: ['my-host-name'] }), null, getContext({ failBorrow: 10, state}));

      cc.init(function (err) {
        cc.shutdown();
        helper.assertInstanceOf(err, errors.NoHostAvailableError);
        assert.deepStrictEqual(state.connectionAttempts.sort(), expectedHosts.sort());
        const resolvedContactPoints = cc.getResolvedContactPoints();
        assert.deepStrictEqual(resolvedContactPoints.get('my-host-name'), expectedResolved);
        done();
      });
    }

    it('should resolve IPv4 and IPv6 addresses', function (done) {
      if (!useLocalhost || !useIp6 ) {
        return done();
      }

      const state = {};
      const cc = newInstance({ contactPoints: [ 'localhost' ] }, getContext({ state, failBorrow: [ 0, 1 ]}));

      cc.init(function (err) {
        cc.shutdown();
        helper.assertInstanceOf(err, errors.NoHostAvailableError);
        assert.deepEqual(state.connectionAttempts.sort(), [ '127.0.0.1:9042', '::1:9042' ]);
        done();
      });
    });
    it('should resolve IPv4 and IPv6 addresses with non default port', function (done) {
      if (!useLocalhost) {
        return done();
      }
      const cc = newInstance({ contactPoints: [ 'localhost:9999' ] }, getContext());
      cc.init(function (err) {
        cc.shutdown();
        cc.hosts.values().forEach(h => h.shutdown());
        assert.ifError(err);
        const hosts = cc.hosts.values();
        assert.strictEqual(hosts.length, 1);
        // Resolved to ::1 or 127.0.0.
        helper.assertContains(hosts[0].address, '1:9999');
        done();
      });
    });
    it('should resolve all IPv4 and IPv6 addresses provided by dns.resolve()', function (done) {
      const ControlConnectionMock = rewire('../../lib/control-connection');
      ControlConnectionMock.__set__('dns', {
        resolve4: function (name, cb) {
          cb(null, ['1', '2']);
        },
        resolve6: function (name, cb) {
          cb(null, ['10', '20']);
        },
        lookup: function () {
          throw new Error('dns.lookup() should not be used');
        }
      });

      testResolution(ControlConnectionMock,
        [ '1:9042', '2:9042', '10:9042', '20:9042' ],
        [ '1:9042', '2:9042', '[10]:9042', '[20]:9042' ], done);
    });
    it('should ignore IPv4 or IPv6 resolution errors', function (done) {
      const ControlConnectionMock = rewire('../../lib/control-connection');
      ControlConnectionMock.__set__('dns', {
        resolve4: function (name, cb) {
          cb(null, ['1', '2']);
        },
        resolve6: function (name, cb) {
          cb(new Error('Test error'));
        },
        lookup: function () {
          throw new Error('dns.lookup() should not be used');
        }
      });
      testResolution(ControlConnectionMock, [ '1:9042', '2:9042'], done);
    });
    it('should use dns.lookup() as failover', function (done) {
      const ControlConnectionMock = rewire('../../lib/control-connection');
      ControlConnectionMock.__set__('dns', {
        resolve4: function (name, cb) {
          cb(new Error('Test error'));
        },
        resolve6: function (name, cb) {
          cb(new Error('Test error'));
        },
        lookup: function (name, cb) {
          cb(null, '123');
        }
      });
      testResolution(ControlConnectionMock, [ '123:9042' ], done);
    });
    it('should use dns.lookup() when no address was resolved', function (done) {
      const ControlConnectionMock = rewire('../../lib/control-connection');
      ControlConnectionMock.__set__('dns', {
        resolve4: function (name, cb) {
          cb(null);
        },
        resolve6: function (name, cb) {
          cb(null, []);
        },
        lookup: function (name, cb) {
          cb(null, '123');
        }
      });
      testResolution(ControlConnectionMock, [ '123:9042' ], done);
    });
    it('should continue iterating through the hosts when borrowing a connection fails', function (done) {
      const state = {};
      const contactPoints = [ '::1', '::2' ];
      const cc = newInstance({ contactPoints }, getContext({ state, failBorrow: [ 0 ] }));

      cc.init(function (err) {
        cc.shutdown();
        assert.ifError(err);
        assert.ok(cc.initialized);
        assert.deepStrictEqual(state.connectionAttempts.sort(), contactPoints.map(x => `${x}:9042`));
        helper.assertMapEqual(
          cc.getResolvedContactPoints(),
          new Map([['::1', ['[::1]:9042']], ['::2', ['[::2]:9042']]]));
        done();
      });
    });
    it('should borrow connections in random order', function (done) {
      // collect unique permutations of borrow order.
      const borrowOrders = new Set();
      utils.times(20, (i, next) => {
        const state = {};
        const cc = newInstance({ contactPoints: [ '::1', '::2', '::3', '::4' ] }, getContext({ state, failBorrow: 4 }));
        cc.init(function (err) {
          cc.shutdown();
          cc.hosts.values().forEach(h => h.shutdown());
          helper.assertInstanceOf(err, errors.NoHostAvailableError);
          borrowOrders.add(state.connectionAttempts.join());
          next();
        });
      }, (err) => {
        assert.ifError(err);
        // should have been more than 1 unique permutation
        assert.ok(borrowOrders.size > 1);
        done();
      });
    });
    it('should callback with NoHostAvailableError when borrowing all connections fail', function (done) {
      const cc = newInstance({ contactPoints: [ '::1', '::2' ] }, getContext({ failBorrow: 2 }));
      cc.init(function (err) {
        cc.shutdown();
        cc.hosts.values().forEach(h => h.shutdown());
        helper.assertInstanceOf(err, errors.NoHostAvailableError);
        assert.strictEqual(Object.keys(err.innerErrors).length, 2);
        assert.ok(!cc.initialized);
        done();
      });
    });
    it('should continue iterating through the hosts when metadata retrieval fails', function (done) {
      const cc = newInstance({ contactPoints: [ '::1', '::2' ] }, getContext({
        queryResults: { '::1': 'Test error, failed query' }
      }));

      cc.init(function (err) {
        cc.shutdown();
        cc.hosts.values().forEach(h => h.shutdown());
        assert.ifError(err);
        done();
      });
    });
    it('should listen to socketClose and reconnect', function (done) {
      const state = {};
      const peersRows = [
        {'rpc_address': types.InetAddress.fromString('::2') }
      ];

      const lbp = new policies.loadBalancing.RoundRobinPolicy();

      const cc = newInstance({ contactPoints: [ '::1', '::2' ], policies: { loadBalancing: lbp } }, getContext({
        state, queryResults: { 'peers': peersRows }
      }));
      cc.init(function (err) {
        assert.ifError(err);
        assert.ok(state.connection);
        assert.strictEqual(state.hostsTried.length, 0);
        assert.strictEqual(state.connectionAttempts.length, 1);
        lbp.init(null, cc.hosts, utils.noop);
        state.connection.emit('socketClose');
        setImmediate(function () {
          // Attempted reconnection and succeeded
          assert.strictEqual(state.hostsTried.length, 1);
          cc.shutdown();
          cc.hosts.values().forEach(h => h.shutdown());
          done();
        });
      });
    });
  });
  describe('#getAddressForPeerHost()', function() {
    it('should handle null, 0.0.0.0 and valid addresses', function (done) {
      const options = clientOptions.extend({}, helper.baseOptions);
      const cc = newInstance(options);
      cc.host = new Host('2.2.2.2', 1, options);
      cc.log = helper.noop;
      const peer = getInet([100, 100, 100, 100]);
      utils.series([
        function (next) {
          const row = {'rpc_address': getInet([1, 2, 3, 4]), peer: peer};
          cc.getAddressForPeerHost(row, 9042, function (endPoint) {
            assert.strictEqual(endPoint, '1.2.3.4:9042');
            next();
          });
        },
        function (next) {
          const row = {'rpc_address': getInet([0, 0, 0, 0]), peer: peer};
          cc.getAddressForPeerHost(row, 9001, function (endPoint) {
            //should return peer address
            assert.strictEqual(endPoint, '100.100.100.100:9001');
            next();
          });
        },
        function (next) {
          const row = {'rpc_address': null, peer: peer};
          cc.getAddressForPeerHost(row, 9042, function (endPoint) {
            //should callback with null
            assert.strictEqual(endPoint, null);
            next();
          });
        }
      ], done);
    });
    it('should call the AddressTranslator', function (done) {
      const options = clientOptions.extend({}, helper.baseOptions);
      let address = null;
      let port = null;
      options.policies.addressResolution = policies.defaultAddressTranslator();
      options.policies.addressResolution.translate = function (addr, p, cb) {
        address = addr;
        port = p;
        cb(addr + ':' + p);
      };
      const cc = newInstance(options);
      cc.host = new Host('2.2.2.2', 1, options);
      cc.log = helper.noop;
      const row = {'rpc_address': getInet([5, 2, 3, 4]), peer: null};
      cc.getAddressForPeerHost(row, 9055, function (endPoint) {
        assert.strictEqual(endPoint, '5.2.3.4:9055');
        assert.strictEqual(address, '5.2.3.4');
        assert.strictEqual(port, 9055);
        done();
      });
    });
  });
  describe('#setPeersInfo()', function () {
    it('should not add invalid addresses', function () {
      const options = clientOptions.extend({}, helper.baseOptions);
      delete options.localDataCenter;
      const cc = newInstance(options);
      cc.host = new Host('18.18.18.18', 1, options);
      const rows = [
        //valid rpc address
        {'rpc_address': getInet([5, 4, 3, 2]), peer: getInet([1, 1, 1, 1])},
        //valid rpc address
        {'rpc_address': getInet([9, 8, 7, 6]), peer: getInet([1, 1, 1, 1])},
        //should not be added
        {'rpc_address': null, peer: utils.allocBufferFromArray([1, 1, 1, 1])},
        //should use peer address
        {'rpc_address': getInet([0, 0, 0, 0]), peer: getInet([5, 5, 5, 5])}
      ];
      cc.setPeersInfo(true, null, { rows: rows }, function (err) {
        assert.ifError(err);
        assert.strictEqual(cc.hosts.length, 3);
        assert.ok(cc.hosts.get('5.4.3.2:9042'));
        assert.ok(cc.hosts.get('9.8.7.6:9042'));
        assert.ok(cc.hosts.get('5.5.5.5:9042'));
      });
    });
    it('should set the host datacenter and cassandra version', function () {
      const options = utils.extend(clientOptions.extend({}, helper.baseOptions), { localDataCenter: 'dc101' });
      const cc = newInstance(options);
      const rows = [
        //valid rpc address
        {'rpc_address': getInet([5, 4, 3, 2]), peer: getInet([1, 1, 1, 1]), data_center: 'dc100', release_version: '2.1.4'},
        //valid rpc address
        {'rpc_address': getInet([9, 8, 7, 6]), peer: getInet([1, 1, 1, 1]), data_center: 'dc101', release_version: '2.1.4'}
      ];
      cc.setPeersInfo(true, null, { rows: rows }, function (err) {
        assert.ifError(err);
        assert.strictEqual(cc.hosts.length, 2);
        assert.ok(cc.hosts.get('5.4.3.2:9042'));
        assert.strictEqual(cc.hosts.get('5.4.3.2:9042').datacenter, 'dc100');
        assert.strictEqual(cc.hosts.get('5.4.3.2:9042').cassandraVersion, '2.1.4');
        assert.ok(cc.hosts.get('9.8.7.6:9042'));
        assert.strictEqual(cc.hosts.get('9.8.7.6:9042').datacenter, 'dc101');
        assert.strictEqual(cc.hosts.get('9.8.7.6:9042').cassandraVersion, '2.1.4');
      });
    });
    it('should throw an error if configured localDataCenter is not found among hosts', function () {
      const options = utils.extend(clientOptions.extend({}, helper.baseOptions), { localDataCenter: 'dc102' });
      const cc = newInstance(options);
      const rows = [
        //valid rpc address
        {'rpc_address': getInet([5, 4, 3, 2]), peer: getInet([1, 1, 1, 1]), data_center: 'dc100', release_version: '2.1.4'},
        //valid rpc address
        {'rpc_address': getInet([9, 8, 7, 6]), peer: getInet([1, 1, 1, 1]), data_center: 'dc101', release_version: '2.1.4'}
      ];
      cc.setPeersInfo(true, null, { rows: rows }, function (err) {
        helper.assertInstanceOf(err, errors.ArgumentError);
      });
    });
    it('should not throw an error if localDataCenter is not configured', function () {
      const options = clientOptions.extend({}, helper.baseOptions);
      delete options.localDataCenter;
      const cc = newInstance(options);
      const rows = [
        //valid rpc address
        {'rpc_address': getInet([5, 4, 3, 2]), peer: getInet([1, 1, 1, 1]), data_center: 'dc100', release_version: '2.1.4'},
        //valid rpc address
        {'rpc_address': getInet([9, 8, 7, 6]), peer: getInet([1, 1, 1, 1]), data_center: 'dc101', release_version: '2.1.4'}
      ];
      cc.setPeersInfo(true, null, { rows: rows }, function (err) {
        assert.ifError(err);
        assert.strictEqual(cc.hosts.length, 2);
      });
    });
  });
  describe('#refresh()', function () {
    it('should schedule reconnection when it cant borrow a connection', function (done) {
      const state = {};
      const lbp = new policies.loadBalancing.RoundRobinPolicy();
      lbp.queryPlanCount = 0;
      lbp.newQueryPlan = function (ks, o, cb) {
        if (lbp.queryPlanCount++ === 0) {
          // Return an empty query plan the first time
          return cb(null, utils.arrayIterator([]));
        }
        return cb(null, [ lbp.hosts.values()[1], lbp.hosts.values()[0] ][Symbol.iterator]());
      };

      const rp = new policies.reconnection.ConstantReconnectionPolicy(40);
      rp.nextDelayCount = 0;
      rp.newSchedule = function*() {
        rp.nextDelayCount++;
        yield this.delay;
      };

      const cc = newInstance({ contactPoints: [ '::1' ], policies: { loadBalancing: lbp, reconnection: rp } },
        getContext({ state: state, queryResults: { 'peers': [ {'rpc_address': types.InetAddress.fromString('::2') } ] }}));

      cc.init(function (err) {
        assert.ifError(err);
        assert.ok(state.connection);
        assert.strictEqual(state.hostsTried.length, 0);
        assert.strictEqual(cc.hosts.length, 2);

        lbp.init(null, cc.hosts, utils.noop);
        const previousConnection = state.connection;
        state.connection.emit('socketClose');

        setImmediate(function () {
          // Scheduled reconnection
          // nextDelayCount should be 2 as both the host and the control connection are reconnecting
          assert.strictEqual(rp.nextDelayCount, 2);
          setTimeout(function () {
            // Reconnected
            assert.strictEqual(state.hostsTried.length, 1);
            // Changed connection
            assert.notEqual(state.connection, previousConnection);
            cc.shutdown();
            cc.hosts.values().forEach(h => h.shutdown());
            done();
          }, 50);
        });
      });
    });
  });
});

/**
 * @param {Array} bytes
 * @returns {exports.InetAddress}
 */
function getInet(bytes) {
  return new types.InetAddress(utils.allocBufferFromArray(bytes));
}

/** @return {ControlConnection} */
function newInstance(options, context) {
  options = clientOptions.extend(options || {});
  return new ControlConnection(options, new ProfileManager(options), context);
}

function getFakeConnection(endpoint, queryResults) {
  queryResults = queryResults || {};
  const c = new events.EventEmitter();
  c.protocolVersion = types.protocolVersion.maxSupported;
  c.endpoint = endpoint;
  c.connected = true;
  c.requests = [];
  const queryResultKeys = Object.keys(queryResults);
  const defaultResult = { rows: [ {} ] };
  c.sendStream = function (request, options, cb) {
    c.requests.push(request);
    let result;
    for (let i = 0; i < queryResultKeys.length; i++) {
      const key = queryResultKeys[i];
      const re = new RegExp(key);
      if (re.test(request.query) || re.test(endpoint)) {
        result = queryResults[key];
        break;
      }
    }

    if (Array.isArray(result)) {
      result = { rows: result };
    }

    if (typeof result === 'string') {
      cb(new Error(result));
    } else {
      cb(null, result || defaultResult);
    }
  };
  c.close = cb => (cb ? cb() : null);
  return c;
}

/**
 * Gets the ControlConnection context
 * @param {{hosts: Array|undefined, failBorrow: Array|undefined, queryResults: Object|undefined,
 *   state: Object|undefined}} [options]
 */
function getContext(options) {
  options = options || {};
  // hosts that the ControlConnection used to borrow a connection
  const state = options.state || {};
  state.connectionAttempts = [];
  state.hostsTried = [];
  let failBorrow = options.failBorrow || [];

  if (typeof failBorrow === 'number') {
    failBorrow = Array.from(new Array(failBorrow).keys());
  }

  let index = 0;

  return {
    borrowHostConnection: function (h, callback) {
      const i = options.state.hostsTried.length;
      options.state.hostsTried.push(h);
      state.host = h;
      if (failBorrow.indexOf(i) >= 0) {
        return callback(new Error('Test error'));
      }

      state.connection = getFakeConnection(h.address, options.queryResults);
      callback(null, state.connection);
    },
    createConnection: function (endpoint, callback) {
      state.connectionAttempts.push(endpoint);
      if (failBorrow.indexOf(index++) >= 0) {
        return callback(new Error('Fake connect error'));
      }

      state.connection = getFakeConnection(endpoint, options.queryResults);
      callback(null, state.connection);
    }
  };
}