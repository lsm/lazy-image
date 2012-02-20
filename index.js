
var genji = require('genji').short();
var connect = require('mongodb-async').connect;

exports.createServer = function(options) {
  var defaultOptions = {
    dbName: 'lazy_image_test',
    dbHost: '127.0.0.1',
    dbPort: 27017,
    dbCollection: 'images'
  };
  var options_ = genji.extend({}, defaultOptions, options);
  var db = connect(options_.dbHost, options_.dbPort, {poolSize: 10}).db(options_.dbName, {});
  db.open();

  genji.use('conditional-get');

  var app = require('./app');
  app.init(db, {
    collection: options_.dbCollection,
    tmpDir: options_.tmpDir
  });

  // create a http server
  var server = genji.createServer();
  return server;
};