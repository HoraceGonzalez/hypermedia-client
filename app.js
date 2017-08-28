var saRequest = require('superagent');
var hypermedia = require('./ResourceFinder.js');

function superAgentHttpRequestFactory (settings) {
    var baseUrl = settings.baseUrl || "";
    baseUrl = baseUrl.endsWith ("/")
        ? baseUrl
        : baseUrl + "/"    
    return function _request(reqParams, cb) {
        console.log(reqParams.method + ' ' + reqParams.url);
        var path = reqParams.url || "";
        var url = path.startsWith("http://") || path.startsWith("https://")
            ? path
            : baseUrl + reqParams.url;

        var req = saRequest(reqParams.method,url)
            .set ("X-RS-Session-Token", settings.sessionToken)
            
        var includes = reqParams.includes || [];
        if (includes.length > 0) {
            req.query({ "include": includes });
        }

        for (var headerName in (reqParams.headers || {})) {
            req.set(headerName,reqParams.headers[headerName]);
        }
            
        req.end(function(err,res){
            if (err) {
                console.log('error:' + err);
            }
            cb(res.body);
        });
    };
}

let client = new hypermedia.HypermediaClient(superAgentHttpRequestFactory({
    baseUrl: "http://localhost:8086/public/api/v1/dealpageeditor/",
    sessionToken: ""
}));

var offering = client
    .from("query/offering?offering_id=4201408783290348")
    //.include(["order-info"]);

// offering.resolveData (function(offering) {
//     console.log(offering);
// });

// var offeringPhotos = offering.follow("offering-photos");
// var offeringTabs = offering.follow("offering-tabs");
// var orderInfo = offering.follow("order-info");

// offeringPhotos.resolveData(function (photos) {
//     for (var i in photos) {
//         console.log ("photos[" + i + "].url = " + photos[i].url);
//     }
// });

// offeringTabs.resolveData (function(data) {
//     var cards = data.cards;
//     for (var i in cards) {
//         console.log ("cards[" + i + "].title = " + cards[i].title);
//     }
// });

// orderInfo.resolveData(function(orderInfo) {
//     console.log("order info:");
//     console.log(orderInfo);
// });

// orderInfo.do("add-to-waitlist").resolveData(function (message) {
//     console.log(message);
// })