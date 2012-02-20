var genji = require('genji').short();
var rootCollection;
var processer;
var ImageProcesser = require('./processer').ImageProcesser;
var app = genji.app();

exports.init = function init(db_) {
  db = db_;
  processer = new ImageProcesser(db_);
};


function processImage(handler) {
  var params = handler.params;
  var url = params.url;
  var deferred = processer.saveImageFromUrl(url);
  var result = [];
  var originalDoc;
  deferred.and(
    function(defer, imageDoc) {
      delete imageDoc.data;
      originalDoc = imageDoc;
      if (params.noLossless) {
        handler.sendJSON([imageDoc]);
        return true;
      } else {
        //lossless compress
        result.push(imageDoc);
        processer.compress(imageDoc, 100, defer);
      }
    },
    function(defer, compressedDoc) {
      if (!params.noLossless) {
        result.push(compressedDoc);
      }
      if (params.width && params.height) {
        processer.resize(originalDoc, params, defer);
      } else {
        handler.sendJSON(result);
      }
    },
    function(defer, resizedDoc) {
      result.push(resizedDoc);
      handler.sendJSON(result);
    })
    .fail(function(err) {
      handler.error(500, 'Image processing error');
      console.error(err.stack || err);
    });
}

function _getImage(filename, callback) {
  var queryDoc = filename.length === 40 ? {_id: filename} : {filename: filename};
  processer.dbCollection.findOne(queryDoc)
    .then(
    function(imageDoc) {
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

// process an image from url
app.get('^/process', processImage);

// get an existing image
app.get('^/image/([0-9a-zA-Z]{40})\\.(jpg|png|gif)$', getImage);
app.notFound('.*', function(handler) {
  handler.error(404, 'invalid end point');
  console.error(this.request.url);
});