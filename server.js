var express = require("express");
var bodyParser = require("body-parser");
var fs = require("fs");
var request = require("request");
var AWS = require("aws-sdk");
var zlib = require("zlib");
var path = require("path");
// TODO set up your Character API key here
var charAPIKey = "53805173";

var polly = new AWS.Polly({
  region: "us-east-1",
  maxRetries: 3,
  //API KEY FOR AWS TO BE ADDED HERE. Mark13.03
  accessKeyId: process.env.AKID || "xxxxxxxxxxxxxx",
  secretAccessKey: process.env.SAK || "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  timeout: 15000,
});

// TODO set the path to your cache directory, and make sure to give it read/write permission, e.g. mkdir cache && sudo chgrp apache cache && sudo chmod g+w cache
var cachePrefix = "./cache/";

// Set up express
var app = express();
app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ limit: "1mb", extended: true }));
app.use(function (request, response, next) {
  response.header("Access-Control-Allow-Origin", "*");
  response.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

// The Character API endpoint
var urlAnimate = "http://mediasemantics.com/animate";

//FORWARD HTML MARK13.03
app.get("/", function (req, res) {
  res.sendFile(path.join(__dirname + "/html/charapiclient.html"));
});

app.get("/charapiclient.js", function (req, res) {
  res.sendFile(path.join(__dirname + "/html/charapiclient.js"));
});

app.get("/animate", function (req, res, next) {
  console.log("animate");
  if (
    req.query.type != "audio" &&
    req.query.type != "image" &&
    req.query.type != "data"
  )
    req.query.type = "image"; // default to image

  
  var character = "SusanHead";

  // TODO - delete this line if your character is always the same
  if (req.query.character) character = req.query.character;

  // These parameters can be derived from the character if they are not supplied
  var charobj = characterObject(character);
  var charstyleobj = characterStyleObject(charobj.style);
  var width = req.query.width || charstyleobj.naturalWidth;
  var height = req.query.height || charstyleobj.naturalHeight;
  var version = req.query.version || charobj.version;
  var format =
    req.query.format ||
    (charobj.style.split("-")[0] == "realistic" ? "jpeg" : "png");

  // Determine an appropriate voice for your character - or you can fix it here instead
  // CUSTOM FUNCTION TO CHANGE VOICE DEPENDING ON THE LANGUAGE. MARK13.03
  var voice = isArabic(req.query.action) ? "Zeina" : "NeuralJoanna";

  // Allow client to override voice. TODO - delete this line if your voice is always the same.
  if (req.query.voice) voice = req.query.voice;

  // Build a hash of all parameters to send to the Character API
  var o = {
    character: character,
    version: version,
    return: "true",
    recover: "true",
    format: format,
    width: width.toString(),
    height: height.toString(),
    charx: "0",
    chary: "0",
    fps: "24",
    quality: "95",
    backcolor: "ffffff",
  };

  // Add to that any other parameters that are variable, from the client
  if (req.query.action) o.action = req.query.action;
  if (req.query.texture) o.texture = req.query.texture;
  if (req.query.with) o.with = req.query.with;
  if (req.query.charx) o.charx = req.query.charx.toString();
  if (req.query.chary) o.chary = req.query.chary.toString();
  if (req.query.lipsync) o.lipsync = req.query.lipsync;
  if (req.query.initialstate) o.initialstate = req.query.initialstate;

  // TODO - if you DO allow parameters to come from the client, then it is a good idea to limit them to what you need. E.g.:
  // if (o.character != "SteveHead" && o.character != "SusanHead") throw new Error('limit reached');  // limit characters
  // if (o.action && o.action.length > 255) throw new Error('limit reached'); // limit message length
  // if (voice != "NeuralJoanna" && voice != "NeuralMatthew") throw new Error('limit reached'); // limit voices

  // Things break further on if we don't have defaults on these
  if (!o.format) o.format = "png";
  if (!o.action) o.action = "";

  // Now use all these parameters to create a hash that becomes the file type
  var crypto = require("crypto");
  var hash = crypto.createHash("md5");
  for (var key in o) hash.update(o[key]);
  hash.update(voice); // This is not a Character API parameter but it also should contribute to the hash
  if (req.query.cache) hash.update(req.query.cache); // Client-provided cache buster that can be incremented when server code changes to defeat browser caching
  var filebase = hash.digest("hex");
  var type = req.query.type; // This is the type of file actually requested - audio, image, or data

  // Simple mechanism to deal with the possibility of two near-simultaneous uncached requests with same parameters
  if (g_inFlight[filebase]) {
    setTimeout(function () {
      checkInFlight(req, res, filebase, type, o.format, 1);
    }, 100);
    return;
  }

  // Case where there is no tts and we can send straight to animate
  if (o.action.indexOf("<say>") == -1 || o.lipsync) {
    if (!fs.existsSync(targetFile(filebase, "image", o.format))) {
      g_inFlight[filebase] = true;
      o.key = charAPIKey;
      o.zipdata = true;
      console.log("---> calling animate w/ " + JSON.stringify(o));
      var animateTimeStart = new Date();
      request.get({ url: urlAnimate, qs: o, encoding: null }, function (
        err,
        httpResponse,
        body
      ) {
        var animateTimeEnd = new Date();
        console.log(
          "<--- back from animate - " +
            (animateTimeEnd.getTime() - animateTimeStart.getTime())
        );
        if (err) return next(new Error(body));
        if (httpResponse.statusCode >= 400) {
          delete g_inFlight[filebase];
          return next(new Error(body));
        }
        fs.writeFile(
          targetFile(filebase, "image", o.format),
          body,
          "binary",
          function (err) {
            if (o.texture) {
              delete g_inFlight[filebase];
              finish(req, res, filebase, type, o.format);
            } else {
              var buffer = Buffer.from(
                httpResponse.headers["x-msi-animationdata"],
                "base64"
              );
              zlib.unzip(buffer, function (err, buffer) {
                fs.writeFile(
                  targetFile(filebase, "data"),
                  buffer.toString(),
                  "binary",
                  function (err) {
                    delete g_inFlight[filebase];
                    finish(req, res, filebase, type, o.format);
                  }
                );
              });
            }
          }
        );
      });
    } else {
      finish(req, res, filebase, type, o.format);
    }
  }
  // Case where we need to get tts and lipsync it first
  else {
    if (!fs.existsSync(targetFile(filebase, "image", o.format))) {
      g_inFlight[filebase] = true;
      var textOnly = o.action
        .replace(new RegExp("<[^>]*>", "g"), "")
        .replace("  ", " "); // e.g. <say>Look <cmd/> here.</say> --> Look here.
        console.log(textOnly)
      var neural = false;
      if (voice.substr(0, 6) == "Neural") {
        // NeuralJoanna or Joanna
        neural = true;
        voice = voice.substr(6);
      }
      var pollyData = {
        OutputFormat: "mp3",
        Text: botReply(msToSSML(textOnly)),   //Check input from front end and then give response based on it. Mark13.03
        TextType: "ssml",
        VoiceId: voice,
        Engine: neural ? "neural" : "standard",
      };
      console.log("---> calling tts w/ " + JSON.stringify(pollyData));
      var ttsTimeStart = new Date();
      polly.synthesizeSpeech(pollyData, function (err, data) {
        if (err) return next(new Error(err.message));
        var ttsTimeEnd = new Date();
        console.log(
          "<--- back from tts - " +
            (ttsTimeEnd.getTime() - ttsTimeStart.getTime())
        );
        fs.writeFile(targetFile(filebase, "audio"), data.AudioStream, function (
          err
        ) {
          if (err) return next(new Error(err.message));
          pollyData.OutputFormat = "json";
          pollyData.SpeechMarkTypes = ["viseme"];
          console.log("---> calling tts w/ " + JSON.stringify(pollyData));
          var ttsTimeStart = new Date();
          polly.synthesizeSpeech(pollyData, function (err, data) {
            if (err) return next(new Error(err.message));
            var ttsTimeEnd = new Date();
            console.log(
              "<--- back from tts - " +
                (ttsTimeEnd.getTime() - ttsTimeStart.getTime())
            );
            var zip = new require("node-zip")();
            zip.file("lipsync", data.AudioStream);
            var dataZipBase64 = zip.generate({
              base64: true,
              compression: "DEFLATE",
            });
            // pass the lipsync result to animate.
            o.key = charAPIKey;
            o.zipdata = true;
            o.lipsync = dataZipBase64;
            // any other tag conversions
            o.action = remainingTagsToXML(
              cmdTagsToXML(removeSpeechTags(o.action))
            );
            console.log("---> calling animate w/ " + JSON.stringify(o));
            var animateTimeStart = new Date();
            request.get({ url: urlAnimate, qs: o, encoding: null }, function (
              err,
              httpResponse,
              body
            ) {
              if (err) return next(new Error(body));
              var animateTimeEnd = new Date();
              console.log(
                "<--- back from animate - " +
                  (animateTimeEnd.getTime() - animateTimeStart.getTime())
              );
              if (httpResponse.statusCode >= 400) {
                delete g_inFlight[filebase];
                return next(new Error(body));
              }
              var buffer = Buffer.from(
                httpResponse.headers["x-msi-animationdata"],
                "base64"
              );
              zlib.unzip(buffer, function (err, buffer) {
                if (err) return next(new Error(err.message));
                fs.writeFile(
                  targetFile(filebase, "image", o.format),
                  body,
                  "binary",
                  function (err) {
                    if (err) return next(new Error(err.message));
                    fs.writeFile(
                      targetFile(filebase, "data"),
                      buffer.toString(),
                      "binary",
                      function (err) {
                        if (err) return next(new Error(err.message));
                        delete g_inFlight[filebase];
                        finish(req, res, filebase, type, o.format);
                      }
                    );
                  }
                );
              });
            });
          });
        });
      });
    } else {
      finish(req, res, filebase, type, o.format);
    }
  }
});

function targetFile(filebase, type, format) {
  if (type == "audio") return cachePrefix + filebase + ".mp3";
  else if (type == "image") return cachePrefix + filebase + "." + format;
  else if (type == "data") return cachePrefix + filebase + ".json";
}

function targetMime(type, format) {
  if (type == "audio") return "audio/mp3";
  else if (type == "image") return "image/" + format;
  else if (type == "data") return "application/json; charset=utf-8";
}

function finish(req, res, filebase, type, format) {
  var frstream = fs.createReadStream(targetFile(filebase, type, format));
  res.statusCode = "200";

  if ((req.get("Origin") || "").indexOf("localhost") != -1)
    res.setHeader("Access-Control-Allow-Origin", req.get("Origin"));
  // TODO: IMPORTANT: Uncomment and fill in your domain here for CORS protection
  //else if ((req.get("Origin")||"").indexOf("yourdomain.com") != -1) res.setHeader('Access-Control-Allow-Origin', req.get("Origin"));*/
  res.setHeader("Cache-Control", "max-age=31536000, public"); // 1 year (long!)
  res.setHeader("content-type", targetMime(type, format));
  frstream.pipe(res);
}

// Simple nodejs way of dealing with a second request for the same file (but different type) while the files are being generated for a first request.
var g_inFlight = {};
function checkInFlight(req, res, filebase, type, format, n) {
  console.log("WAITING " + n);
  if (!g_inFlight[filebase]) {
    finish(req, res, filebase, type, format);
  } else if (n > 100) {
    // 10sec
    console.log("IN-FLIGHT TIMEOUT");
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.write("timeout");
    res.end();
    return;
  } else
    setTimeout(function () {
      checkInFlight(req, res, filebase, type, format, n + 1);
    }, 100);
}

function msToSSML(s) {
  var ret = ssmlHelper(s, true);
  // Any remaining tags can be eliminated for tts
  ret = ret.replace(/\[[^\]]*\]/g, "").replace("  ", " "); // e.g. Look [cmd] here. --> Look here.
  return ret;
}

function removeSpeechTags(s) {
  return ssmlHelper(s, false);
}

function ssmlHelper(s, use) {
  var old = s;

  // SSML is very strict about closing tags - we try to automatically close some tags
  if (
    use &&
    s.indexOf("[conversational]") != -1 &&
    s.indexOf("[/conversational]") == -1
  )
    s += "[/conversational]";
  if (use && s.indexOf("[news]") != -1 && s.indexOf("[/news]") == -1)
    s += "[/news]";

  // Super-useful [spoken]...[/spoken][written]...[/written] (take all of spoken, take none of written)
  s = s.replace(/\[spoken\](.*?)\[\/spoken\]/g, use ? "$1" : "");
  s = s.replace(/\[written\](.*?)\[\/written\]/g, use ? "" : "$1");

  // Pause
  s = s.replace(/\[silence ([0-9.]*)s\]/g, use ? '<break time="$1s"/>' : ""); // [silence 1.5s]
  s = s.replace(/\[silence ([0-9.]*)ms\]/g, use ? '<break time="$1ms"/>' : ""); // [silence 300ms]

  // Emphasis - note that these are not supported by polly except in non-neural, which we try to avoid, so eliminating from the speech tags for now.

  // Language
  s = s.replace(/\[english\]/g, use ? '<lang xml:lang="en-US">' : ""); // [english]...[/english]
  s = s.replace(/\[\/english\]/g, use ? "</lang>" : "");
  s = s.replace(/\[arabic\]/g, use ? '<lang xml:lang="ar">' : ""); // [english]...[/english]
  s = s.replace(/\[\/arabic\]/g, use ? "</lang>" : "");
  s = s.replace(/\[french\]/g, use ? '<lang xml:lang="fr-FR">' : ""); // [french]...[/french]
  s = s.replace(/\[\/french\]/g, use ? "</lang>" : "");
  s = s.replace(/\[spanish\]/g, use ? '<lang xml:lang="es">' : ""); // [spanish]...[/spanish]
  s = s.replace(/\[\/spanish\]/g, use ? "</lang>" : "");
  s = s.replace(/\[italian\]/g, use ? '<lang xml:lang="it">' : ""); // [italian]...[/italian]
  s = s.replace(/\[\/italian\]/g, use ? "</lang>" : "");
  s = s.replace(/\[german\]/g, use ? '<lang xml:lang="de">' : ""); // [german]...[/german]
  s = s.replace(/\[\/german\]/g, use ? "</lang>" : "");

  // Say as
  s = s.replace(/\[spell\]/g, use ? '<say-as interpret-as="characters">' : ""); // [spell]a[/spell]
  s = s.replace(/\[\/spell\]/g, use ? "</say-as>" : "");
  s = s.replace(/\[digits\]/g, use ? '<say-as interpret-as="digits">' : ""); // [digits]123[/digits]
  s = s.replace(/\[\/digits\]/g, use ? "</say-as>" : "");
  s = s.replace(/\[verb\]/g, use ? '<w role="amazon:VB">' : ""); // [verb]present[/verb]
  s = s.replace(/\[\/verb\]/g, use ? "</w>" : "");
  s = s.replace(/\[past\]/g, use ? '<w role="amazon:VBD">' : ""); // [past]present[/past]
  s = s.replace(/\[\/past\]/g, use ? "</w>" : "");
  s = s.replace(/\[alt\]/g, use ? '<w role="amazon:SENSE_1">' : ""); // [alt]bass[/alt]
  s = s.replace(/\[\/alt\]/g, use ? "</w>" : "");

  // Breathing not supported by neural, so will not include it

  s = s.replace(
    /\[ipa (.*?)\]/g,
    use ? '<phoneme alphabet="ipa" ph="$1">' : ""
  ); // [ipa pɪˈkɑːn]pecan[/ipa]
  s = s.replace(/\[\/ipa\]/g, use ? "</phoneme>" : "");
  var m;
  while ((m = s.match(/\[sampa (.*?)\]/))) {
    s = s.replace(
      m[0],
      use
        ? '<phoneme alphabet="x-sampa" ph="' +
            m[1]
              .replace(/"/g, "&quot;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;") +
            '">'
        : ""
    );
  }
  s = s.replace(/\[\/sampa\]/g, use ? "</phoneme>" : "");
  s = s.replace(
    /\[pinyin (.*?)\]/g,
    use ? '<phoneme alphabet="x-amazon-pinyin" ph="$1">' : ""
  ); // [pinyin bao2]薄[/pinyin]
  s = s.replace(/\[\/pinyin\]/g, use ? "</phoneme>" : "");

  s = s.replace(/\[drc\]/g, use ? '<amazon:effect name="drc">' : ""); // [drc]dynamic range correction[/drc]
  s = s.replace(/\[\/drc\]/g, use ? "</amazon:effect>" : "");

  // Speaking style
  s = s.replace(
    /\[conversational\]/g,
    use ? '<amazon:domain name="conversational">' : ""
  ); // [conversational]...[/conversational]
  s = s.replace(/\[\/conversational\]/g, use ? "</amazon:domain>" : "");
  s = s.replace(/\[news\]/g, use ? '<amazon:domain name="news">' : ""); // [news]...[/news]
  s = s.replace(/\[\/news\]/g, use ? "</amazon:domain>" : "");

  // volume
  s = s.replace(/\[volume (.*?)\]/g, use ? '<prosody volume="$1">' : ""); // [volume loud]...[/volume] [volume -6dB]...[/volume]
  s = s.replace(/\[\/volume\]/g, use ? "</prosody>" : "");
  // rate
  s = s.replace(/\[rate (.*?)\]/g, use ? '<prosody rate="$1">' : ""); // [rate slow]...[/rate] [rate 80%]...[/rate]
  s = s.replace(/\[\/rate\]/g, use ? "</prosody>" : "");
  // pitch
  s = s.replace(/\[pitch (.*?)\]/g, use ? '<prosody pitch="$1">' : ""); // [pitch high]...[/pitch] [pitch +5%]...[/pitch]
  s = s.replace(/\[\/pitch\]/g, use ? "</prosody>" : "");

  //if (use && s != old) console.log("SSML: " + old + " -> " + s);
  if (use) return "<speak>" + s + "</speak>";
  else return s;
}

function cmdTagsToXML(s) {
  // [cmd] -> <cmd/>
  // [cmd type="foo" arg="bar"] -> <cmd type="foo" arg="bar"/>
  var m, mm;
  while ((m = s.match(/\[cmd(.*?)\]/))) {
    var args = m[1];
    let t = "<cmd";
    while ((mm = args.match(/\w*=".*?"/))) {
      t = t + " " + mm[0];
      args = args.replace(mm[0], "");
    }
    t = t + "/>";
    s = s.replace(m[0], t);
  }
  return s;
}

function remainingTagsToXML(s) {
  // [headright] -> <headright/>
  s = s.replace(/\[([\w-]*?)\]/g, "<$1/>");
  // [pause 500ms] -> <pause msec="$1"/>
  s = s.replace(/\[pause (.*?)ms\]/g, '<pause msec="$1"/>');
  return s;
}

// This is handy character data, but is subject to change

var characterStyles = [
  {
    id: "realistic-head",
    name: "Realistic Head",
    naturalWidth: 250,
    naturalHeight: 200,
    recommendedWidth: 250,
    recommendedHeight: 200,
    recommendedX: 0,
    recommendedY: 0,
  },
  {
    id: "realistic-bust",
    name: "Realistic Bust",
    naturalWidth: 375,
    naturalHeight: 300,
    recommendedWidth: 275,
    recommendedHeight: 300,
    recommendedX: -50,
    recommendedY: 0,
  },
  {
    id: "realistic-body",
    name: "Realistic Body",
    naturalWidth: 500,
    naturalHeight: 400,
    recommendedWidth: 300,
    recommendedHeight: 400,
    recommendedX: -100,
    recommendedY: 0,
  },
  {
    id: "illustrated-head",
    name: "Illustrated Head",
    naturalWidth: 250,
    naturalHeight: 200,
    recommendedWidth: 250,
    recommendedHeight: 200,
    recommendedX: 0,
    recommendedY: 0,
  },
  {
    id: "illustrated-body",
    name: "Illustrated Body",
    naturalWidth: 307,
    naturalHeight: 397,
    recommendedWidth: 300,
    recommendedHeight: 400,
    recommendedX: 0,
    recommendedY: 0,
  },
  {
    id: "cs",
    name: "Cartoon Solutions",
    naturalWidth: 307,
    naturalHeight: 397,
    recommendedWidth: 300,
    recommendedHeight: 400,
    recommendedX: 0,
    recommendedY: 0,
  },
  {
    id: "classic",
    name: "Classic Cartoon",
    naturalWidth: 307,
    naturalHeight: 397,
    recommendedWidth: 300,
    recommendedHeight: 400,
    recommendedX: 0,
    recommendedY: 0,
  },
  {
    id: "cgi-head",
    name: "CG Cartoon Head",
    naturalWidth: 250,
    naturalHeight: 200,
    recommendedWidth: 250,
    recommendedHeight: 200,
    recommendedX: 0,
    recommendedY: 0,
  },
  {
    id: "cgi-bust",
    name: "CG Cartoon Bust",
    naturalWidth: 375,
    naturalHeight: 300,
    recommendedWidth: 275,
    recommendedHeight: 300,
    recommendedX: -50,
    recommendedY: 0,
  },
  {
    id: "cgi-body",
    name: "CG Cartoon Body",
    naturalWidth: 500,
    naturalHeight: 400,
    recommendedWidth: 300,
    recommendedHeight: 400,
    recommendedX: -100,
    recommendedY: 0,
  },
];

var characters = [
  {
    id: "SusanHead",
    style: "realistic-head",
    name: "Susan",
    gender: "female",
    defaultVoice: "NeuralJoanna",
    version: "3.0",
    thumb: "img/characters/SusanHead.gif",
  },
];

function characterStyleObject(id) {
  for (var i = 0; i < characterStyles.length; i++)
    if (characterStyles[i].id == id) return characterStyles[i];
  return null;
}

function characterObject(id) {
  for (var i = 0; i < characters.length; i++)
    if (characters[i].id == id) return characters[i];
  return null;
}

//CUSTOM FUNCTION TO RESPOND BASED ON REQUEST TEXT. Mark13.03
function botReply(botQ){
    if (botQ == "<speak>Hello</speak>"){
        return "<speak>Hi, How are you.</speak>";
    }
    else if (botQ == "<speak>Who are you?</speak>"){
        return "<speak>I am a bot designed by Arabot.</speak>";
    }
    else if (botQ == "<speak>مرحبا</speak>"){
        return "<speak>مرحبا كيف حالك؟</speak>";
    }
    else if (botQ == "<speak>من أنت</speak>"){
        return "<speak>أنا روبوت من تصميم أرابوت.</speak>";
    }
    else {
        return botQ;
    }
}


//CUSTOM FUNCTION TO CHECK IF THE TEXT IS ARABIC OR ENGLISH MARK13.03
function isArabic(text) {
    var pattern = /[\u0600-\u06FF\u0750-\u077F]/;
    result = pattern.test(text);
    return result;
    }

app.listen( process.env.PORT || 3000, function () {
  console.log("Listening on port 3000");
});
