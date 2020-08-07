'use strict'

var util = require('util')
var EventEmitter = require('events').EventEmitter
var xtend = require('xtend')
var request = require('request')
var weighted = require('weighted')
var maybe = require('mostly-working-hours')
var expand = require('brace-expansion')
var weekend = require('is-it-weekend')
var pkg = require('./package')

var USER_AGENT = pkg.name + '/' + pkg.version

module.exports = Workload

function Workload (opts) {
  if (!(this instanceof Workload)) return new Workload(opts)

  EventEmitter.call(this)

  this.sentRequests = 0
  this.finishedRequests = 0

  var self = this
  var realInterval = 1000 / ((opts.max || 12) / 60) // default to max 12 requests per minute
  var reqPerMs = 1 / realInterval
  var interval = Math.round(realInterval)
  var maxSpeed = interval <= 1
  var filters = opts.filters || [opts.filter || function (_, cb) { cb() }]
  this._defaultHeaders = opts.headers

  var weights = opts.requests.map(function (req) {
    return req.weight || 1
  })

  var startTime = Date.now()

  var makeRequestNextTick = function() {
    if (!self._timer) return
    var expectedRequests = (Date.now() - startTime) * reqPerMs
    var requestsOver = self.sentRequests - expectedRequests;
    if (requestsOver > 0) {
      setTimeout(makeRequestNextTick, Math.round(requestsOver * realInterval) + 1) // Maintain speed.
    } else {
      if (self.sentRequests % 500 === 0) {
        setTimeout(makeRequest, 1) // Allow other logic do their events.
      } else {
        process.nextTick(makeRequest)    
      }
    }
  }

  var makeRequest = function() {
    var req = xtend({}, weighted.select(opts.requests, weights))
    req.url = req.url.replace(/{{random}}/gi, Math.random())
    iterator(req)
    makeRequestNextTick()
  }

  this._timer = true
  makeRequestNextTick()

  function iterator (req, n) {
    if (!n) n = 0
    var filter = filters[n]
    if (!filter) return self._visit(req)
    filter(req, function (modified) {
      iterator(modified || req, ++n)
    })
  }

  this.logTimer = setInterval(function() {
    console.log('[' +  new Date().toISOString() + ']', 'Finished/sent requests:', self.finishedRequests, '/', self.sentRequests)
  }, 1000)
}

util.inherits(Workload, EventEmitter)

Workload.stdFilters = {
  workdays: function (req, cb) {
    var odds = weekend() ? 0.2 : 1
    if (Math.random() <= odds) cb()
  },
  workingHours: function (req, cb) {
    maybe(cb)
  },
  expand: function (req, cb) {
    var urls = expand(req.url)
    req.url = urls[Math.round(Math.random() * (urls.length - 1))]
    cb()
  }
}

Workload.prototype.stop = function stop () {
  // Assign `null` for explicit check.
  this._timer = null
  this.emit('stop', {
    time: new Date(),
  })
}

Workload.prototype.finish = function finish () {
  clearInterval(this.logTimer)
  this.emit('finish')
}

Workload.prototype._visit = function _visit (req) {
  var self = this
  var time = Date.now()
  req.headers = xtend({'user-agent': USER_AGENT}, this._defaultHeaders, req.headers)

  this.sentRequests++

  req.timeout = 30 * 1000;

  request(req, function (err, res, body) {
    self.finishedRequests++

    if (err) {
      self.emit('error', err)
    } else {
      var time_diff = Date.now() - time
      self.emit('visit', {
        request: req,
        response: res,
        body: body,
        time: time_diff
      }) 
    }

    if (!self._timer && self.finishedRequests === self.sentRequests) {
      self.finish()
    }
  })
}
