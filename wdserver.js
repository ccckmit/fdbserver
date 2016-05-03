var S = require("./fdbserver");
var mzfs = require('mz/fs');
var wdlib = require('./web/wdlib');
var config = require('./web/config');

var staticHtml = mzfs.readFileSync(__dirname+'/web/static.html', 'utf-8');

function replace(str, source, target) {
  return str.split(source).join(target);
}
	
S.doBeforeFileGet=function*(path, self) {
	if (path==="/") {
		self.response.redirect("/wd.html#main:home");
		return true;
	} else if (path.startsWith("/view/")) {
		var wd = yield mzfs.readFile(S.routeMap.cwd+path.replace('/view/', '/file/')+".wd", 'utf-8');
		var domain = path.split("/")[1];
		var wdHtml = wdlib.wd2html(wd, domain);
		var toHtml = replace(staticHtml, "{%=wdHtml%}", wdHtml);
		toHtml = replace(toHtml, "{%=pathLink%}", config.title[domain]);
		toHtml = replace(toHtml, "{%=title%}", config.title[domain]);
		self.body = toHtml;
		return true;
	}
	return false;
}

S.run();


