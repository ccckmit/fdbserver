var MongoClient = require('mongodb').MongoClient;

MongoClient.connect("mongodb://localhost:27017/examdb", function(err, db) {
  if(err) { return console.dir(err); }

  var collection = db.collection('Q');
  var docs = [{ type:"word", q:"he=¥L"}, { type:"word", q:"she=¦o"}, { type:"word", q:"it=¥¦"} ];

  collection.insert(docs, {w:1}, function(err, result) { // success!

    collection.find().toArray(function(err, items) {
        console.log("items=%j", items);
        db.close();
    });
  });
});