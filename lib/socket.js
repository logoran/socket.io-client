
/**
 * Module dependencies.
 */

var parser = require('socket.io-parser');
var Emitter = require('component-emitter');
var toArray = require('to-array');
var on = require('./on');
var bind = require('component-bind');
var debug = require('debug')('socket.io-client:socket');
var parseqs = require('parseqs');
var compose = require('logoran-compose');
const accepts = require('accepts');
const statuses = require('statuses');
const Stream = require('stream');
const BufferHelper = require('bufferhelper');
const context = require('./context');
const response = require('./response');
const request = require('./request');
const assert = require('assert');
const only = require('only');
const isError = require('is-error');

/**
 * Module exports.
 */

module.exports = exports = Socket;

/**
 * Internal events (blacklisted).
 * These events can't be emitted by the user.
 *
 * @api private
 */

var events = {
  connect: 1,
  connect_error: 1,
  connect_timeout: 1,
  connecting: 1,
  disconnect: 1,
  error: 1,
  reconnect: 1,
  reconnect_attempt: 1,
  reconnect_failed: 1,
  reconnect_error: 1,
  reconnecting: 1,
  ping: 1,
  pong: 1,
  execute_error: 1
};

/**
 * Shortcut to `Emitter#emit`.
 */

var emit = Emitter.prototype.emit;

/**
 * `Socket` constructor.
 *
 * @api public
 */

function Socket (io, nsp, opts) {
  this.io = io;
  this.nsp = nsp;
  this.json = this; // compat
  this.ids = 0;
  this.acks = {};
  this.receiveBuffer = [];
  this.sendBuffer = [];
  this.connected = false;
  this.disconnected = true;
  this.fns = [];
  this.fn = compose(this.fns);
  if (opts && opts.query) {
    this.query = opts.query;
  }
  if (this.io.autoConnect) this.open();
  this.context = Object.create(context);
  this.request = Object.create(request);
  this.response = Object.create(response);
  this.state = {};
}

/**
 * Mix in `Emitter`.
 */

Emitter(Socket.prototype);

/**
 * Return JSON representation.
 * We only bother showing settings.
 *
 * @return {Object}
 * @api public
 */

Socket.prototype.toJSON = function() {
  return only(this, [
    'id',
    'nsp',
    'state'
  ]);
};

/**
 * Inspect implementation.
 *
 * @return {Object}
 * @api public
 */

Socket.prototype.inspect = function() {
  return this.toJSON();
};

/**
 * Subscribe to open, close and packet events
 *
 * @api private
 */

Socket.prototype.subEvents = function () {
  if (this.subs) return;

  var io = this.io;
  this.subs = [
    on(io, 'open', bind(this, 'onopen')),
    on(io, 'packet', bind(this, 'onpacket')),
    on(io, 'close', bind(this, 'onclose'))
  ];
};

/**
 * "Opens" the socket.
 *
 * @api public
 */

Socket.prototype.open =
Socket.prototype.connect = function () {
  if (this.connected) return this;

  this.subEvents();
  this.io.open(); // ensure open
  if ('open' === this.io.readyState) this.onopen();
  this.emit('connecting');
  return this;
};

/**
 * Sends a `message` event.
 *
 * @return {Socket} self
 * @api public
 */

Socket.prototype.send = function () {
  var args = toArray(arguments);
  args.unshift('message');
  this.emit.apply(this, args);
  return this;
};

var methods = [
  'Head',
  'Options',
  'Get',
  'Put',
  'Patch',
  'Post',
  'Delete'
];

/**
 * Sends a `http` event with method argument.
 *
 * @param {String} method
 * @param {Object} headers object
 * @param {String} url
 * @return {Socket} self
 * @api public
 */

Socket.prototype.Http = function(method, headers, url) {
  let args = Array.prototype.slice.call(arguments, 1);
  args.unshift('http' + method.toUpperCase());
  let origin = arguments[arguments.length - 1];
  if ('function' == typeof origin) {
    args[args.length - 1] = responseHandler(origin);
  }
  this.emit.apply(this, args);
  return this;
};

/**
 * Create functions sends a `http` event of method.
 *
 * @param {Object} headers object
 * @param {String} url
 * @return {Socket} self
 * @api public
 */

methods.forEach(function (method) {
  debug('Create http function %s', method);
  let fullMethod = 'http' + method.toUpperCase();
  Socket.prototype[method] = function (headers, url) {
    let args = Array.prototype.slice.call(arguments);
    args.unshift(fullMethod);
    let origin = arguments[arguments.length - 1];
    if ('function' == typeof origin) {
      args[args.length - 1] = responseHandler(origin);
    }
    this.emit.apply(this, args);
    return this;
  };
});

/**
 * Override `emit`.
 * If the event is in `events`, it's emitted normally.
 *
 * @param {String} event name
 * @return {Socket} self
 * @api public
 */

Socket.prototype.emit = function (ev) {
  if (events.hasOwnProperty(ev)) {
    emit.apply(this, arguments);
    return this;
  }

  var args = toArray(arguments);
  var packet = { type: parser.EVENT, data: args };

  packet.options = {};
  packet.options.compress = !this.flags || false !== this.flags.compress;

  // event ack callback
  if ('function' === typeof args[args.length - 1]) {
    debug('emitting packet with ack id %d', this.ids);
    this.acks[this.ids] = args.pop();
    packet.id = this.ids++;
  }

  if (this.connected) {
    this.packet(packet);
  } else {
    this.sendBuffer.push(packet);
  }

  delete this.flags;

  return this;
};

/**
 * Sends a packet.
 *
 * @param {Object} packet
 * @api private
 */

Socket.prototype.packet = function (packet) {
  packet.nsp = this.nsp;
  this.io.packet(packet);
};

/**
 * Called upon engine `open`.
 *
 * @api private
 */

Socket.prototype.onopen = function () {
  debug('transport is open - connecting');

  // write connect packet if necessary
  if ('/' !== this.nsp) {
    if (this.query) {
      var query = typeof this.query === 'object' ? parseqs.encode(this.query) : this.query;
      debug('sending connect packet with query %s', query);
      this.packet({type: parser.CONNECT, query: query});
    } else {
      this.packet({type: parser.CONNECT});
    }
  }
};

/**
 * Called upon engine `close`.
 *
 * @param {String} reason
 * @api private
 */

Socket.prototype.onclose = function (reason) {
  debug('close (%s)', reason);
  this.connected = false;
  this.disconnected = true;
  delete this.id;
  this.emit('disconnect', reason);
};

/**
 * Called with socket packet.
 *
 * @param {Object} packet
 * @api private
 */

Socket.prototype.onpacket = function (packet) {
  if (packet.nsp !== this.nsp) return;

  switch (packet.type) {
    case parser.CONNECT:
      this.onconnect();
      break;

    case parser.EVENT:
      this.onevent(packet);
      break;

    case parser.BINARY_EVENT:
      this.onevent(packet);
      break;

    case parser.ACK:
      this.onack(packet);
      break;

    case parser.BINARY_ACK:
      this.onack(packet);
      break;

    case parser.DISCONNECT:
      this.ondisconnect();
      break;

    case parser.ERROR:
      this.emit('error', packet.data);
      break;
  }
};

/**
 * Called upon a server event.
 *
 * @param {Object} packet
 * @api private
 */

Socket.prototype.onevent = function (packet) {
  var args = packet.data || [];
  debug('emitting event %j', args);

  if (null != packet.id) {
    debug('attaching ack callback to event');
    args.push(this.ack(packet.id));
  }

  if (this.connected) {
    this.dispatch(args);
  } else {
    this.receiveBuffer.push(args);
  }
};

/**
 * Produces an ack callback to emit with an event.
 *
 * @api private
 */

Socket.prototype.ack = function (id) {
  var self = this;
  var sent = false;
  return function () {
    // prevent double callbacks
    if (sent) return;
    sent = true;
    var args = toArray(arguments);
    debug('sending ack %j', args);

    self.packet({
      type: parser.ACK,
      id: id,
      data: args
    });
  };
};

/**
 * Called upon a server acknowlegement.
 *
 * @param {Object} packet
 * @api private
 */

Socket.prototype.onack = function (packet) {
  var ack = this.acks[packet.id];
  if ('function' === typeof ack) {
    debug('calling ack %s with %j', packet.id, packet.data);
    ack.apply(this, packet.data);
    delete this.acks[packet.id];
  } else {
    debug('bad ack %s', packet.id);
  }
};

/**
 * Called upon server connect.
 *
 * @api private
 */

Socket.prototype.onconnect = function () {
  this.connected = true;
  this.disconnected = false;
  this.emit('connect');
  this.emitBuffered();
};

/**
 * Emit buffered events (received and emitted).
 *
 * @api private
 */

Socket.prototype.emitBuffered = function () {
  var i;
  for (i = 0; i < this.receiveBuffer.length; i++) {
    this.dispatch(this.receiveBuffer[i]);
  }
  this.receiveBuffer = [];

  for (i = 0; i < this.sendBuffer.length; i++) {
    this.packet(this.sendBuffer[i]);
  }
  this.sendBuffer = [];
};

/**
 * Called upon server disconnect.
 *
 * @api private
 */

Socket.prototype.ondisconnect = function () {
  debug('server disconnect (%s)', this.nsp);
  this.destroy();
  this.onclose('io server disconnect');
};

/**
 * Called upon forced client/server side disconnections,
 * this method ensures the manager stops tracking us and
 * that reconnections don't get triggered for this.
 *
 * @api private.
 */

Socket.prototype.destroy = function () {
  if (this.subs) {
    // clean subscriptions to avoid reconnections
    for (var i = 0; i < this.subs.length; i++) {
      this.subs[i].destroy();
    }
    this.subs = null;
  }

  this.io.destroy(this);
};

/**
 * Produces an `error` packet.
 *
 * @param {Object} err error object
 * @api private
 */

Socket.prototype.error = function(err){
  this.packet({ type: parser.ERROR, data: {data: err.data, message: err.message, stack: err.stack} });
};

/**
 * Disconnects the socket manually.
 *
 * @return {Socket} self
 * @api public
 */

Socket.prototype.close =
Socket.prototype.disconnect = function () {
  if (this.connected) {
    debug('performing disconnect (%s)', this.nsp);
    this.packet({ type: parser.DISCONNECT });
  }

  // remove socket from pool
  this.destroy();

  if (this.connected) {
    // fire events
    this.onclose('io client disconnect');
  }
  return this;
};

/**
 * Sets the compress flag.
 *
 * @param {Boolean} if `true`, compresses the sending data
 * @return {Socket} self
 * @api public
 */

Socket.prototype.compress = function (compress) {
  this.flags = this.flags || {};
  this.flags.compress = compress;
  return this;
};

/**
 * Initialize a new context.
 *
 * @api private
 */

Socket.prototype.createContext = function(req, res) {
  const context = Object.create(this.context);
  const request = context.request = Object.create(this.request);
  const response = context.response = Object.create(this.response);
  context.app = request.app = response.app = this.io;
  context.req = request.req = response.req = req;
  context.res = request.res = response.res = res;
  request.ctx = response.ctx = context;
  request.response = response;
  response.request = request;
  context.originalUrl = request.originalUrl = req.url;
  context.accept = request.accept = accepts(req);
  // context.cookies = this.cookies;
  return context;
};

/**
 * Handle request in callback.
 *
 * @api private
 */

Socket.prototype.handleRequest = function(ctx) {
  const res = ctx.res;
  res.statusCode = 404;
  const onerror = err => ctx.onerror(err);
  const handleResponse = () => respond(ctx);
  return this.fn(ctx).then(handleResponse).catch(onerror);
};

/**
 * Handle event in callback.
 *
 * @api private
 */

Socket.prototype.handleEvent = function(event) {
  try {
    emit.apply(this, event);
  } catch (err) {
    this.error(err);
  }
};

/**
 * Dispatch incoming event to socket listeners.
 *
 * @param {Array} event that will get emitted
 * @api private
 */

Socket.prototype.dispatch = function(event){
  debug('dispatching an event %j', event);
  let req = prepareRequest(event, this);
  if (req){
    let res = prepareResponse(event);
    const ctx = this.createContext(req, res);
    this.handleRequest(ctx);
  } else {
    this.handleEvent(event);
  }
};

/**
 * Sets up socket middleware.
 *
 * @param {Function} middleware function (ctx, next)
 * @return {Socket} self
 * @api public
 */

Socket.prototype.use = function(fn){
  this.fns.push(fn);
  return this;
};

/**
 * Default error handler.
 *
 * @param {Error} err
 * @api private
 */

Socket.prototype.onerror = function(err) {
  assert(isError(err), `non-error thrown: ${err}`);

  if (404 == err.status || err.expose) return;
  if (this.silent) return;

  const msg = err.stack || err.toString();
  console.error();
  console.error(msg.replace(/^/gm, '  '));
  console.error();
};

/**
 * Return the id as host
 *
 * @return {String} host
 * @api public
 */

Socket.prototype.__defineGetter__('host', function hostGetter() {
  return this.id;
});

/**
 * Return the id as host, alias as socket.host
 *
 * @return {String} hostname
 * @api public
 */

Socket.prototype.__defineGetter__('hostname', function hostnameGetter() {
  return this.id;
});

/**
 * Return the protocol string "http" or "https"
 *
 * @return {String}
 * @api public
 */

Socket.prototype.__defineGetter__('protocol', function protocolGetter() {
  return 'http';
});

/**
 * Response helper.
 */

function respond(ctx) {
  // allow bypassing logoran
  // if (false === ctx.respond) return;

  const res = ctx.res;
  if (!ctx.writable) return;

  let body = ctx.body;
  const code = ctx.status;

  // ignore body
  if (statuses.empty[code]) {
    // strip headers
    ctx.body = null;
    return res.end();
  }

  if ('HEAD' == ctx.method) {
    return res.end();
  }

  // set slot to body
  if (undefined === body && ctx.slot) {
    ctx.status = 200;
    body = ctx.slot;
  }

  // status body
  if (null == body) {
    body = ctx.message || String(code);
    return res.end(body);
  }

  // responses
  if (Buffer.isBuffer(body)) return res.end(body);
  if ('string' == typeof body) return res.end(body);
  if (body instanceof Stream) return res.end(body);

  // body: json
  if (Array.isArray(body)) return res.end(body);
  return res.end(body);
}

/**
 * Response handler helper.
 */

function responseHandler(fn) {
  return function() {
    let headers;
    let status;
    let body;
    let offset;
    let length = arguments.length;
    if ('object' == typeof arguments[0]) {
      headers = arguments[0];
      status = arguments[1];
      offset = 2;
    } else {
      headers = {};
      status = arguments[0];
      offset = 1;
    }
    if (offset == length) {
      body = undefined;
    } else if (offset == length - 1) {
      body = arguments[offset];
    } else {
      body = arguments.slice(offset);
    }
    fn({headers: headers, status: status, body: body});
  };
}

function prepareRequest(event, socket) {
  if ('HTTP' !== event[0].slice(0, 4).toUpperCase()) {
    return null;
  }
  let method = event[0].slice(4);
  let url;
  let headers;
  let body;
  let length = event.length;
  let offset;
  if ('object' == typeof event[1]) {
    headers = event[1];
    url = event[2];
    offset = 3;
  } else {
    headers = {};
    url = event[1];
    offset = 2;
  }
  if ('string' != typeof url) {
    return null;
  }
  if ('function' == typeof event[length - 1]) {
    if (offset == length - 1) {
      body = null;
    } else if (offset == length - 2) {
      body = event[offset];
    } else {
      body = event.slice(offset, -1);
    }
  } else {
    if (offset == length) {
      body = null;
    } else if (offset == length - 1) {
      body = event[offset];
    } else {
      body = event.slice(offset);
    }
  }
  return {method: method, url: url, headers: headers, body: body, socket: socket};
}

function prepareResponse(event) {
  let cbfn = event[event.length - 1];
  if ('function' != typeof cbfn) {
    return {headers: {}, cbfn: null, end: function(data) {
      console.error('can\'t respond to client');
    }};
  }
  return {headers: {}, cbfn: cbfn, end: function(data) {
    if (Array.isArray(data)) {
      let _data = data.slice();
      if (Object.keys(this.headers).length) {
        _data.unshift(this.headers, this.statusCode);
      } else {
        _data.unshift(this.statusCode);
      }
      return this.cbfn.apply(null, _data);
    }
    if (data instanceof Stream) {
      let _data = new BufferHelper();
      data.on('data', function(chunk){
        _data.concat(chunk);
      });
      let self = this;
      data.on('end', function(){
        data.destroy();
        Object.keys(self.headers).length ? self.cbfn(self.headers, self.statusCode, _data.toBuffer()) : self.cbfn(self.statusCode, _data.toBuffer());
      });
      return;
    }
    if (data) {
      return Object.keys(this.headers).length ? this.cbfn(this.headers, this.statusCode, data) : this.cbfn(this.statusCode, data);
    } else {
      return Object.keys(this.headers).length ? this.cbfn(this.headers, this.statusCode) : this.cbfn(this.statusCode);
    }
  }};
}
