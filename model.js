var genji = require('genji');
var Model = genji.Model;
var dateformat = require('dateformat');
var sha1 = genji.crypto.sha1;

/**
 * Image collection:
 *
 * {
 *   _id: '441547af33d49c4f37461fa87a5bb502b40687f2', // sha1 hash of the file content
 *   filename: '441547af33d49c4f37461fa87a5bb502b40687f2_100_200x300', // filename
 *   coarseLoc: '20120118', // the first sharding key, default is the date when the image is created
 *   data: '', // image binary data
 *   type: 'image/jpeg', // mime type
 *   length: 77031, // binary length of image
 *   created: ISODate("2011-08-27T17:45:29.976Z"), // date created
 *   url: 'http://p0.meituan.net/deal/201108/24/shotu1.jpg', // url of oringinal image (optional)
 *   quality: 100, // image quality (optional),
 *   width: 200, // image width in px (optional)
 *   height: 300 // image height in px (optional)
 * }
 *
 * filename: (hash-of-original-file)_(quality)_(widthxheight)
 * Quality 100 not resized (lossless compressed): 441547af33d49c4f37461fa87a5bb502b40687f2_100
 * Quality 70, resized 200x300: 441547af33d49c4f37461fa87a5bb502b40687f2_70_200x300
 *
 */

var ImageModel = Model('ImageModel', {
  fields: {
    // '441547af33d49c4f37461fa87a5bb502b40687f2', sha1 hash of the file content
    id: 'string',
    // '20120618' image creation date string, can be used as first sharding key (coarse location key)
    date: 'string',
    // user specified filename, default is (hash-of-original-file)_(quality)_(widthxheight)_(watermark)
    // could be used as second sharding key (search key)
    filename: 'string',
    // image blob
    data:function (value) {
      return !Buffer.isBuffer(value);
    },
    // mime type
    type: 'string',
    // binary length of image
    length: 'number',
    // url of oringinal image (optional)
    url: 'string',
    // image quality (optional),
    quality: 'number',
    // image width in px (optional)
    width: 'number',
    // image height in px (optional)
    height: 'number',
    // '1' if image has watermark, else omit this field, optional
    watermark: '1',
    // date created
    created: 'date'
  },

  init:function (data) {
    if (!data._id) {
      if (!data.date) {
        this.attr('date', dateformat(new Date, "yyyymmdd"));
      }
      this.attr('created', new Date);
      if (!data.quality) {
        this.attr('quality', 100);
      }
    }
  },

  setData:function (value) {
    this.attr('id', sha1(value));
    return value;
  },

  getFilename:function (value) {
    var filename = this.attr('id');
    if (value) {
      filename = value + '_' + filename;
    };
    var quality = this.attr('quality');
    if (quality) {
      filename += '_' + quality;
    }
    var size = this.attr(['width', 'height']);
    if (size.width && size.height) {
      filename += '_' + size.width + 'x' + size.height;
    }
    var watermark = this.attr('watermark');
    if (watermark) {
      filename += '_wm';
    }
    return filename;
  }

});

exports.ImageModel = ImageModel;