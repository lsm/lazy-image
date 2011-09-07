var genji = require('genji').short();
var db;
var rootCollection;
var imageFS;
var processer;
var ImageProcesser = require('./processer').ImageProcesser;
var app = genji.app();

exports.init = function init(db_, rootCollection_) {
  db = db_;
  rootCollection = rootCollection_;
  processer = new ImageProcesser(db_);
  imageFS  = db.gridfs(rootCollection);
};


function processImage(handler) {
  var params = handler.params;
  var url = params.url;
  var deferred = processer.saveImageFromUrl(url);
  var result = [];
  deferred.and(function(defer, imageDoc) {
      result.push(imageDoc);
    //lossless compress
      processer.compress(imageDoc, 100, defer);
    }).and(function(defer, compressedDoc) {
      result.push(compressedDoc);
      if (params.width && params.height) {
        processer.resize(compressedDoc, params, defer);
      } else {
        handler.sendJSON(result);
      }
    }).and(function(defer, resized) {
      result.push(resized);
      handler.sendJSON(result);
    })
    .fail(function(err) {
      console.log('err: ' + err);
      handler.error(500, err.stack || err);
    });
}

function _getImage(filename, callback) {
  imageFS
    .read(filename)
    .then(
    function(data) {
      callback(null, data);
    }).fail(callback);
}

function getImage(handler, filename, ext) {
  _getImage(filename, function(err, data) {
    if (err || !data) {
      handler.error(404, 'Image not found');
    } else {
      var headers = {type: 'image/jpeg'};
      handler.sendAsFile(data, headers);
    }
  });
}

app.get('^/process', processImage);
app.get('^/image/([0-9a-zA-Z]{32})\\.(jpg|png|gif)$', getImage);
app.notFound('.*', function(handler) {
  console.log(this.request.url);
  handler.error(404, 'invalid end point');
});