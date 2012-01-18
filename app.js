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
    delete imageDoc.data;
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
  var queryDoc = filename.length === 40 ? {_id: filename} : {filename: filename};
  processer.dbCollection.findOne(queryDoc)
    .then(function(imageDoc) {
      callback(null, imageDoc);
    }).fail(callback);
}

function getImage(handler, filename) {
  _getImage(filename, function(err, imageDoc) {
    if (err || !imageDoc) {
      handler.error(404, 'Image not found');
    } else {
      var headers = {type: imageDoc.type};
      handler.sendAsFile(imageDoc.data.value(), headers);
    }
  });
}

app.get('^/process', processImage);
app.get('^/image/([0-9a-zA-Z]{40})\\.(jpg|png|gif)$', getImage);
app.notFound('.*', function(handler) {
  console.log(this.request.url);
  handler.error(404, 'invalid end point');
});