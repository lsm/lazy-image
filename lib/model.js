var genji = require('genji');
var Model = genji.Model;
var dateformat = require('dateformat');
var sha1 = genji.crypto.sha1;

var ImageModel = Model('ImageModel', {
  fields: {
    // '441547af33d49c4f37461fa87a5bb502b40687f2', sha1 hash of the file content, first sharding key
    // high cardinality + write scaling
    id: 'string',
    // '20120618' image creation date string, second sharding key
    // query isolation
    date: 'string',
    // generated filename
    filename: 'string',
    // original filename
    name: 'string',
    // image blob
    data:function (value) {
      return !Buffer.isBuffer(value);
    },
    // mime type
    type: 'string',
    // binary length of image
    length: 'number',
    // image quality
    quality: 'number',
    // image width in px
    width: 'number',
    // image height in px
    height: 'number',
    // url of oringinal image (optional)
    url: 'string',
    // '1' if image has watermark, else omit this field, optional
    watermark: 'string',
    // date created
    created: 'date'
  },

  init: function (data) {
    !data.date && this.attr('date', dateformat(new Date, "yyyymmdd"));
    !data.created && this.attr('created', new Date);
    !data.quality && this.attr('quality', 100);
    !data.filename && this.attr('filename', this.attr('filename'));
    !data.hasOwnProperty('watermark') && this.attr('watermark', '0');
  },

  setData:function (value) {
    this.attr('id', sha1(value));
    return value;
  },

  getFilename:function () {
    var filenameHash = {id: this.attr('parentId') || this.attr('id')};
    filenameHash.quality = this.attr('quality') || 100;
    var size = this.attr(['width', 'height']);
    filenameHash.width = size.width || 0;
    filenameHash.height = size.height || 0;
    filenameHash.watermark = this.attr('watermark') || 0;
    var filename = sha1(JSON.stringify(filenameHash));
    return filename;
  }

});

exports.ImageModel = ImageModel;

//var i = {
//  id: sha1('1'),
//  name: 'test.jpg',
//  date: '20120918',
//  width: 120,
//  height: 210
//};
//var im = new ImageModel(i);
//
//console.log(im.toDoc());
//console.log(im.toData());