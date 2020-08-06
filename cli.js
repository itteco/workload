#!/usr/bin/env node
'use strict'

var path = require('path')
var http = require('http')
var argv = require('minimist')(process.argv.slice(2))
var csv = require('csv-line')
var Workload = require('./')
var pkg = require('./package')
var fs = require('fs')

var FILTERS = {
  WD: Workload.stdFilters.workdays,
  WH: Workload.stdFilters.workingHours,
  EX: Workload.stdFilters.expand
}

function getFilenameDateString() {
  const date = new Date();
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day =`${date.getDate()}`.padStart(2, '0');
  return `${year}${month}${day}-${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}`
}

if (argv.h || argv.help) help()
else if (argv.v || argv.version) version()
else if (argv.f || argv.file || argv._.length) run()
else invalid()

function run () {
  var data_file = {}
  var file = argv.f || argv.file
  var opts
  if (file) {
    file = path.resolve(file)
    console.log(file)
    opts = require(file)
  } else {
    opts = {}
    if (argv.max) opts.max = argv.max
    if (argv.filter) {
      if (!Array.isArray(argv.filter)) argv.filter = [argv.filter]
      opts.filters = argv.filter.map(function (name) {
        return FILTERS[name]
      })
    }
    if (argv.H) opts.headers = parseHeaders(argv.H)
    if (argv.H) opts.headers = parseHeaders(argv.H)

    opts.requests = argv._.map(function (line) {
      var parts = csv.decode(line)
      var req = {}
      if (Number.isFinite(parts[0])) req.weight = parts.shift()
      if (http.METHODS.indexOf(parts[0]) !== -1) req.method = parts.shift()
      req.url = parts.shift()
      if (parts.length) req.body = parts[0]
      return req
    })
  }

  var total = 0;
  var bad = 0;
  var hits = {};
  var start_time = new Date();
  var time_diff = [];

  var workload = new Workload(opts);

  workload.on('error', function(err) {
    bad += 1;
    if (!argv.silent) {
      console.log("\x1b[31m", start_time, err)
    }
  });

  workload.on('visit', function(visit) {
    const date =  new Date().toISOString().substr(11, 8);
    if (hits[date]) {
      hits[date]++
    } else {
      hits[date] = 1
    }
    total++;
    time_diff.push(visit.time);
    if (!argv.silent) {
        var method = visit.request.method || 'GET'
        var url = visit.request.url
        var code = visit.response.statusCode
        console.log("\x1b[32m", '%d %s %s %s', code, http.STATUS_CODES[code], method, url)
    }

  });

  workload.on('stop', function(data) {
    const arrAvg = arr => arr.reduce((a,b) => a + b, 0) / arr.length;
    var timeDiff = data.time - start_time;
    timeDiff /= 1000;
    var ran_seconds = Math.round(timeDiff);
    var avgreq = Math.round(arrAvg(time_diff));
    var avghits = arrAvg(Object.values(hits));
    var url = opts.requests[0].url;
    var random = /{{random}}/gi.test(url);
    if (!opts.silent) {
      console.log("\x1b[34m", 'Url: ' + url);
      console.log("\x1b[34m", 'Total requests:', total);
      console.log("\x1b[34m", 'start:', start_time);
      console.log("\x1b[34m", 'finish:', data.time);
      console.log('Avg r/s: ', avghits);
      console.log('Ran for: ', ran_seconds + " seconds");
      console.log('Avg req/time: ', avgreq);
      console.log("\x1b[34m", 'Random url: ', random);
    }
    data_file.total_requests = total;
    data_file.test_start = start_time;
    data_file.test_finish = data.time;
    data_file.averege_requests = avghits;
    data_file.test_duration_sec = ran_seconds;
    data_file.avg_req_time = avgreq;
    data_file.url = opts.requests[0];
    data_file.random = random;
  });


  // stop fuse switch in micro seconds.
  // e.g. 10000 === 10 seconds
  setTimeout(function () {
    workload.stop();
    setTimeout(function () {
      if (!opts.silent) {
        console.log("\x1b[31m", 'Bad requests:', bad);
      }
      data_file.bad_requests = bad;

      if (opts.save_stats) {
        fs.writeFile(`results-${getFilenameDateString()}.json`, JSON.stringify(data_file, null, 2), 'utf8', (err) => {
          if (err) throw err;
          console.log('Data written to file');
        });
      }
    }, opts.test_duration_sec * 1000 + 120000); // Wit for Bad requests for 2 minutes more
  }, opts.test_duration_sec * 1000);
}

function parseHeaders (lines) {
  var headers = {}
  lines.forEach(function (line) {
    var split = line.indexOf(':')
    headers[line.slice(0, split)] = line.slice(split + 1).trim()
  })
  return headers
}

function invalid () {
  console.log('ERROR: Invalid arguments!')
  console.log()
  help()
  process.exit(1)
}

function help () {
  console.log(`Usage:
  ${pkg.name} [options] requests...

Options:

  -h, --help       Show this help
  -v, --version    Show the version
  -f, --file PATH  Load config from JSON file
  --silent         Don't output anything
  --max NUM        The maximum number of requests per minute (default: 12)
  --filter NAME    Use named standard filter (see Filters section below)
  -H LINE          Add default HTTP header (can be used multiple times)

Filter names:

  WD   Workdays - This filter lowers the chances of a request being made during
       weekends
  WH   Working Hours - This filter lowers the chances of a request being made
       during weekends and at night
  EX   Expand - This filter expands braces in URL's and picks a random matching
       URL

Each request is a comma separated list of values follwoing this pattern:

  [WEIGHT,][METHOD,]URL[,BODY]

  WEIGHT  The numeric weight of the request (default: 1)
  METHOD  HTTP method (default: GET)
  URL     Full URL to request (required)
  BODY    The HTTP body

Examples:

  ${pkg.name} http://example.com http://example.com/foo
    Make two GET requests with equal weight

  ${pkg.name} 1,http://example.com 2,http://example.com/foo
    Make two GET requests with a double chance of the latter being made

  ${pkg.name} --max=60 http://example.com POST,http://example.com,"Hello World"
    Make a maximum of one request per second and make either a GET
    request or a POST request with the body "Hello World"

  ${pkg.name} -H "Accept: text/plain" http://example.com
    Set a custom Accept header
`)
}

function version () {
  console.log(pkg.version)
}
