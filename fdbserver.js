var fs      = require('fs');
var path    = require('path');
var http    = require('http');
var https   = require('https');
var mzfs    = require('mz/fs');
var mkdirp  = require('mkdirp');
var koa     = require('koa');
// 參考：http://codeforgeek.com/2014/09/handle-get-post-request-express-4/
var bodyParser = require("koa-bodyparser");
var session = require('koa-session');
var router  = require('koa-router')();
var co      = require('co');
var parse   = require('co-busboy');
var saveTo  = require('save-to');
var mongodb = require('mongodb');
// var setting = require('./setting');
var app = koa();

var routeMap = {
  coderoot:path.join(__dirname, ''),
	web:path.join(__dirname, 'web'),
  file:path.join(process.cwd(), 'file'),
  cwd:process.cwd(),
};

function comkdir(path) {
  return function (callback) {
    mkdirp(path, callback);
  };
}

function loadSysFile(file) {
	var filepath = path.join(routeMap.cwd, file);
	if (!mzfs.existsSync(filepath)) {
		filepath = path.join(routeMap.coderoot, file);
	}
	return mzfs.readFileSync(filepath, 'utf-8');
}

var setting = JSON.parse(loadSysFile('setting.json'));
var passwords = setting.passwords;

var db = {
	db : null,
	tableMap:{},
}

db.table=function(tableName) { 
  var table = db.tableMap[tableName];
  if (typeof table === 'undefined') {
		table = db.tableMap[tableName] = db.db.collection(tableName);
	}
	return table;
}

mongodb.MongoClient.connect(setting.mongodb.dburl, function(err, db1){
	if (err) 
		console.error("db connect fail");
	else
		console.log('Connect to', setting.mongodb.dburl, 'success!');
	db.db=db1;
});

var fdbserver = {
	app:app,
	router:router,
	routeMap:routeMap,
	loadSysFile:loadSysFile,
	run:function() { this.app.run(); }
}

if (!fs.existsSync(routeMap.file)) {
	fs.mkdir(routeMap.file+"/");	
}

app.keys = [setting.key];
app.use(session(app));
app.use(bodyParser({formLimit:5*1000*1000, jsonLimit:5*1000*1000}));

function response(res, code, msg) {
  res.status = code;
  res.set({'Content-Length':''+msg.length,'Content-Type':'text/plain'});
  res.body = msg;
	if (code !== 200) console.log('response error : ', code, msg);
}

fdbserver.response = response;
fdbserver.doBeforeFileGet=function*(path, self) { return false; }

function isPass(req) {
  if (setting.loginToSave === false) 
    return true;
  return typeof(req.session.user)!=='undefined';
}

var dbOp=function*(table, op, body, self) {
  var req = self.request, res = self.response;
  if (!isPass(self)) {
    response(res, 401, 'Please login to save!');
    return;
  }
	if (!db.db) response(res, 404, 'db error!');
	var results=null;
	if (op === 'find') {
    // 範例: http://localhost/db?table=filelog&filter={"path":"/db.filelog"}
		var filter=JSON.parse(body.filter);
		results = yield db.table(table).find(filter).toArray();
	} else if (op === 'insert') {
		var records = JSON.parse(body.records);
		results = yield db.table(table).insertMany(records);
	} else if (op === 'update') {
		var filter = JSON.parse(body.filter);
		var update = JSON.parse(body.update);
		results = yield db.table(table).updateMany(filter, update);
	} else if (op === 'delete') {
		var filter = JSON.parse(body.filter);
		results = yield db.table(table).deleteMany(filter);		
	}
	if (results) {
		self.body = results;
	} else {
		response(res, 404, 'db error');
	}
	fdbserver.doAfterPostDb(table, op, body);
}

router
 .post('/upload/', function*(next) {
  var domain = this.request.url.split("/").pop();
  if (!this.request.header["content-type"].startsWith("multipart/form-data;")) return yield next;
  var part, parts = parse(this);
  var files = [], file;
  while (part = yield parts) {
    if (typeof part.filename !== 'undefined') {
      files.push(file = path.join(routeMap.file, domain, part.filename));
      yield saveTo(part, file);
    }
  }
  this.body = files;	
 })
 .post('/db/:table/:op', function*(next){
	yield dbOp(this.params.table, this.params.op, this.request.body, this);
 })
 .get('/db/:table/:op',  function*(next){
	yield dbOp(this.params.table, this.params.op, this.request.query, this);
 })
 .post("/login", function*(next) {
  var req = this.request, res = this.response;
  var p = this.request.body;
  if (req.protocol !== 'https') {
    response(res, 401, p.user+":login fail!");
    return;
  }  
  if (p.user in passwords && passwords[p.user].toUpperCase() === p.password.toUpperCase()) {
    this.session.user = p.user;
    response(res, 200, p.user+":login success!");
  } else {
    response(res, 401, p.user+":login fail!");
  }
 })
 .post("/logout", function*(next) {
  var req = this.request, res = this.response;
  this.session = null;
  response(res, 200, "logout success!");
 }) 
 .post(/\/file\/.*/, function*(next) {
  var req = this.request, res = this.response;
//	var domain = this.params.domain, file=this.params.file;
  var text = this.request.body.text;
  if (!isPass(this)) {
    response(res, 401, 'Please login to save!');
    return;
  }
  console.log('post %s', this.path)
	var dir = this.path.split("/");
	dir.pop();
	console.log(" dir=", dir);
	yield comkdir(routeMap.cwd+dir.join("/"));
  yield mzfs.writeFile(routeMap.cwd+this.path, text).then(function() {
    response(res, 200, 'write success!');
  }).catch(function() {
    response(res, 403, 'write fail!'); // 403: Forbidden
  });
 })
 .get(/.*/, function *(next) {
	if (db.db) {
		yield db.table('filelog').insert({path:this.path, time:new Date()});
	}
	if (yield fdbserver.doBeforeFileGet(this.path, this))
		return;
	console.log('get %s', this.path);
	var root = this.path.startsWith("/file/")?routeMap.cwd:routeMap.web;
	var tpath = path.join(root, this.path);
	var tstat = yield mzfs.stat(tpath);
//	console.log('tstat=%j', tstat);
	if (tstat.isDirectory()) {
		var files = yield mzfs.readdir(tpath);
//	  console.log('files=%j', files);
		this.type = 'json';
		this.body = {type:"directory", "files":files};
	} else if (tstat.isFile()) {
		var ext = path.extname(tpath)
		this.type = ([".wd",".md"].indexOf(ext)>=0)?'.txt':ext;
		this.body = mzfs.createReadStream(tpath);
	}
 });

app.run=function() {
	app.use(router.routes());
	app.use(router.allowedMethods());
	
	var port = setting.port || 80; // process.env.PORT for Heroku
	console.log('Server started: http://localhost:'+port);
	http.createServer(app.callback()).listen(port);
	
  // https version : in self signed certification
  // You can save & modify in SSL mode, no edit allowed in HTTP mode.
	var sslPort = setting.portSsl || 443;
	https.createServer({
		key: loadSysFile('key.pem'),
		cert: loadSysFile('cert.pem'),
		// The folowing is for self signed certification.
		requestCert: true, 
		ca: [ loadSysFile('csr.pem') ]
	}, app.callback()).listen(sslPort);
	console.log('Ssl Server started: https://localhost:'+sslPort);
}

module.exports = fdbserver;

if (!module.parent) {
  app.run();
  console.log('app running');
}

/*
 .post('/file/:domain/:file', function*(next) {
  var req = this.request, res = this.response;
	var domain = this.params.domain, file=this.params.file;
  var text = this.request.body.text;
  if (!isPass(this)) {
    response(res, 401, 'Please login to save!');
    return;
  }
  console.log('post %s:%s', domain, file)
  yield mzfs.mkdir(routeMap.file+"/"+domain+"/").catch(function(){});
  yield mzfs.writeFile(routeMap.file+"/"+domain+"/"+file, text).then(function() {
    response(res, 200, 'write success!');
  }).catch(function() {
    response(res, 403, 'write fail!'); // 403: Forbidden
  });
 })
*/