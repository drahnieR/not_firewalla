/*    Copyright 2016 Firewalla LLC 
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';
let log = require('./logger.js')(__filename);
var stats = require('stats-lite');

const rclient = require('../util/redis_manager.js').getRedisClient()

let Promise = require('bluebird');

var DNSManager = require('./DNSManager.js');
var dnsManager = new DNSManager('info');
var bone = require("../lib/Bone.js");
var firewalla = require("../net2/Firewalla.js");

const _async = require('async');
var flowUtil = require('../net2/FlowUtil.js');
var instance = null;

var QUERY_MAX_FLOW = 10000;

var bconfig;
// Will use bconfig.config.flow.activitymin/activitymax
var flowconfig = {
    activityDetectMin : 10,
    activityDetectMax : 60*60*5,
}; 

let flowTool = require('./FlowTool')();

const HostTool = require('./HostTool.js');
const hostTool = new HostTool();

class FlowGraph {
    constructor(name,flowarray) {
         if (flowarray) {
             this.flowarray = flowarray;
         } else {
             this.flowarray = [];
         }
         this.name = name;
         firewalla.getBoneInfo((err,config)=>{
             bconfig = config;
             if (bconfig.config.flow && bconfig.config.flow.activityDetectMin) {
                 flowconfig = bconfig.config.flowManager;
             }
         });
    }


    flowarraySorted(recent) {
        if (recent == true) {
            // sort by end timestamp in descending order
            this.flowarray.sort(function (a, b) {
                return Number(b[1]) - Number(a[1]);
            })
            return this.flowarray;
        } else {
            this.flowarray.sort(function (a, b) {
                return Number(a[1]) - Number(b[1]);
            })
            return this.flowarray;
        }
    }


    addFlow(flow) {
         if (flow.flows == null) {
             let flowStart = Math.ceil(Number(flow.__ts) - Number(flow.du));
             let flowEnd = Math.ceil(Number(flow.__ts));
             if (flow.__ts==null) {
                 flowStart = Math.ceil(Number(flow._ts) - Number(flow.du));
                 flowEnd = Math.ceil(Number(flow._ts));
             }
             let ob = Number(flow.ob);
             let rb = Number(flow.rb);
                
             this.addRawFlow(flowStart,flowEnd,ob,rb,flow.ct);
         } else {
             //log.info("$$$ before ",flow.flows);
             for (let i in flow.flows) {
                 let f = flow.flows[i];
                 this.addRawFlow(f[0],f[1],f[2],f[3],1);
             }
             //log.info("$$$ after",this.flowarray);
         }
    }

    addRawFlow(flowStart, flowEnd, ob,rb,ct) {
        let insertindex = 0;

        for (let i in this.flowarray) {
            let e = this.flowarray[i];
            if (flowStart < e[0]) {
                break;
            }
            if (flowStart<e[1]) {
                flowStart = e[0];
                break;
            }
            insertindex = Number(i)+Number(1);
        }

        let removed = Number(0);
        for (let i = insertindex; i < this.flowarray.length; i++) {
            let e = this.flowarray[Number(i)];
            if (e[1] < flowEnd) {
                ob += e[2];
                rb += e[3];
                ct += e[4];
                removed++;
                continue;
            } else if (e[1] >= flowEnd) {
                if (e[0] <= flowEnd) {
                    // [flowStart, flowEnd] has overlap with [e[0], e[1]]
                    ob += e[2];
                    rb += e[3];
                    ct += e[4];
                    flowEnd = e[1];
                    removed++;
                }
                break;
            }
        }

        this.flowarray.splice(insertindex,removed, [flowStart,flowEnd, ob,rb,ct]);
    //     log.info("insertindex",insertindex,"removed",removed,this.flowarray,"<=end");
    }

}

module.exports = class FlowManager {
    constructor(loglevel) {
        if (instance == null) {
            let cache = {};
            instance = this;
        }
        return instance;
    }

    

  // use redis hash to store last 24 hours stats
  recordLast24HoursStats(timestamp, downloadBytes, uploadBytes, target) {
    
    if(!downloadBytes || !uploadBytes)
      return Promise.reject(new Error("either downloadBytes or uploadBytes is null"));
    
    let key = 'stats:last24';
    
    if(target)
      key = key + ":" + target;

    let downloadKey = key + ":download";
    let uploadKey = key + ":upload";
    
    timestamp = timestamp - timestamp % 3600; // trim minutes and seconds...
    const now = Date.now() / 1000;
    const currentHour = ((now - now % 3600) / 3600);
    if (currentHour - timestamp / 3600 > 23) {
      // rounded timestamp is more than 23 hours ago, which is out of range
      return Promise.resolve();
    }

    let hourOfDay = (timestamp / 3600) % 24;
    let downloadValue = JSON.stringify({bytes: downloadBytes, ts: timestamp});
    let uploadValue = JSON.stringify({bytes: uploadBytes, ts: timestamp});

    return rclient.hsetAsync(downloadKey, hourOfDay, downloadValue)
      .then(rclient.expireAsync(downloadKey, 3600 * 24))
      .then(rclient.hsetAsync(uploadKey, hourOfDay, uploadValue))
      .then(rclient.expireAsync(uploadKey, 3600 * 24))
      .catch((err) => {
        log.error("Got error when recording last 24 hours stats: " + err);
        throw err;
      });
  }

  /*
   * {
   *   "1" : '{ "ts": "1494817200", "bytes": "200" }', 
   *   "2" : '{ "ts": "1494820800", "bytes": "300" }',
   *   ...
   * }
   * 
   * TO
   * 
   * { 
   *   "1494817200": "200", 
   *   "1494820800": "300"... 
   * }
   *   
   */
  getOrderedStats(stats) {
    let orderedStats = {};

    if(stats === null)
      return orderedStats;
    
    let keys = Object.keys(stats);

    
    for(let key in keys) {
      let v = stats[keys[key]];
      let o = JSON.parse(v);
      if(o.ts && o.bytes) {
        orderedStats[parseInt(o.ts, 10)] = parseInt(o.bytes, 10);
      }
    }

    return orderedStats;
  }

  filterOldData(stats) {
    let beginDate = new Date() / 1000 - 60 * 60 * 24;
    for(let key in stats) {
      if(parseInt(key, 10) < beginDate) {
        delete stats[key];
      }
    }
    return stats;
  }

  last24HourDatabaseExists() {
    return rclient.existsAsync("stats:last24:download");
  }
  
  getLast24HoursDownloadsStats(target) {
    let key = 'stats:last24';
    
    if(target)
      key = key + ":" + target;

    let downloadKey = key + ":download";

    return rclient.hgetallAsync(downloadKey)
      .then((stats) => {
        let s = this.getOrderedStats(stats);
        this.filterOldData(s);
        return s;
      });
  }

  getLast24HoursUploadsStats(target) {
    let key = 'stats:last24';
    
    if(target)
      key = key + ":" + target;

    let uploadKey = key + ":upload";

    return rclient.hgetallAsync(uploadKey)
      .then((stats) => {
        let s = this.getOrderedStats(stats)
        this.filterOldData(s);
        return s;
      });
  }

  list24HoursTicks() {
    let list = [];
    
    let tsnow = Math.ceil(Date.now()/1000);
    tsnow = tsnow-tsnow%3600;

    for(let i = 0; i<24; i++) {
      list.push(tsnow - i * 3600);
    }

    return list;
  }

  // stats:type:in:ip => stats:last24
  migrateFromOldTableForHost(ip) {
    let downloadKey = "stats:"+type+":in:"+ip;
    let uploadKey = "stats:"+type+":out:"+ip;

    let ticks = this.list24HoursTicks();

    let downloadPromises = ticks.map((tick) => rclient.zscoreAsync(downloadKey, tick));
    let uploadPromises = ticks.map((tick) => rclient.zscoreAsync(uploadKey, tick));

    return Promise.all(downloadPromises)
      .then((downloadBytesList) => {
        Promise.all(uploadPromises)
          .then((uploadBytesList) => {
            let pList = [];
            for(let i in ticks) {
              let ip2 = ip;
              if(ip2 === "0.0.0.0")
                ip2 = null;
              pList.push(this.recordLast24HoursStats(ticks[i], downloadBytesList[i], uploadBytesList[i], ip2));
            }
            return Promise.all(pList);
          });
      });
  }

  
  
    // stats are 'hour', 'day'
    // stats:hour:mac_address score=bytes key=_ts-_ts%3600
    // target = 0.0.0.0 is system
  recordStats(target,type,ts,inBytes,outBytes,callback) {
    callback = callback || function() {}
    
        let period = 3600;
        if (type === "day") {
            period = 60*60*24;
        } else if (type ==="month") {
            period = 60*60*24*30;
        }
        let inkey = "stats:"+type+":in:"+target;
        let outkey = "stats:"+type+":out:"+target;
        // round down according to period
        let subkey = ts-ts%period;

        if (inBytes == null || outBytes == null) {
            return;
        }

      rclient.zincrby(inkey,Number(inBytes),subkey,(err,downloadBytes)=>{
        if(err) {
          log.error("Failed to record stats on download bytes: " + err);
          callback(err);
          return;
        }

        rclient.zincrby(outkey,Number(outBytes),subkey,(err,uploadBytes)=>{
          if(err) {
            log.error("Failed to record stats on upload bytes: " + err);
            return;
          }

          if(target === "0.0.0.0")
            target = null;
          
          this.recordLast24HoursStats(subkey, downloadBytes, uploadBytes, target)
            .then(() => {
              callback();
            }).catch((err) => {
              log.error("Failed to record stats on last 24 hours stats: " + err);
              callback(err);
            });
        }); 
      }); 
    }

  parseGetStatsResult(result, db, from, to) {
    let bytes = 0;
    
    if (result && result.length==2) {
      let array = result[1];
      log.debug("array:",array.length);
      for (let i=0;i<array.length;i++) {
        let clock = Number(array[i]);
        let bytes = Number(array[i+1]);
        i++;
        if (clock<Number(from)) {
          continue;
        }
        if (Number(to)!=-1 &&  clock>to) {
          continue;
        }
        
        if (db[clock]) {
          db[clock] += Number(bytes);
        } else {
          db[clock] = Number(bytes);
        }
        bytes+=Number(bytes);
      }
    }

    return bytes;
  }

  sumFlows(flows) {
    let result = {};

    if(flows.length === 0) {
      return result;
    }

    let flow1 = flows[0];

    if(!flow1)
      return result;

    Object.keys(flow1).map((k) => {
      let sum = flows.reduce((total, flow) => {
        if(flow[k] && parseInt(flow[k]) !== NaN) {
          return total + parseInt(flow[k]);
        } else {
          return total;
        }
      }, 0);
      result[k] = sum;
    });

    return result;
  }

  sumBytes(flow) {
    return Object.keys(flow).reduce((total, key) => {
      if(flow[key] && parseInt(flow[key]) !== NaN) {
        return total + parseInt(flow[key]);
      }
      return total;
    }, 0);
  }

  flowToLegacyFormat(flow) {
    let result = [];
    
    return Object.keys(flow)
      .sort((a,b) => b-a)
      .map((key) => {
        return {size: flow[key], ts: key + ""};
      });
  }

  // no parameters accepted
  getSystemStats() {
    let flowsummary = {};
    flowsummary.inbytes = 0;
    flowsummary.outbytes = 0;
    flowsummary.type = "hour";

    let tsnow = Math.ceil(Date.now()/1000);
    tsnow = tsnow-tsnow%3600;
    flowsummary.tophour = tsnow;

    let download = this.getLast24HoursDownloadsStats();
    let upload = this.getLast24HoursUploadsStats();
    
    return Promise.join(download, upload, (d, u) => {
      flowsummary.flowinbytes = this.flowToLegacyFormat(d);
      flowsummary.inbytes = this.sumBytes(d);
      flowsummary.flowoutbytes = this.flowToLegacyFormat(u);
      flowsummary.outbytes = this.sumBytes(u);
      return new Promise((resolve) => resolve(flowsummary));
    });   
  }

  // no parameters accepted
  getStats2(host) {
    if(!host) {
      // if host is null, consider this is system stats
      return this.getSystemStats();
    }

    
    host.flowsummary = {};
    host.flowsummary.inbytes = 0;
    host.flowsummary.outbytes = 0;
    host.flowsummary.type = "hour";

    let tsnow = Math.ceil(Date.now()/1000);
    tsnow = tsnow-tsnow%3600;
    
    host.flowsummary.tophour = tsnow;

    const mac = host.o.mac;
    let downloadPromiseList = [this.getLast24HoursDownloadsStats(mac)]; // you may be wondering why a single element list is used here. 
    // It is changed from a previous implementation which aggregates stats by ip addresses, and a host may have multiple ip addresses. The promise list is retained to avoid changing code structure too much.


    return Promise.all(downloadPromiseList)
      .then((results) => {
        let sum = this.sumFlows(results);
        let legacyFormat = this.flowToLegacyFormat(sum);
        host.flowsummary.flowinbytes = legacyFormat;
        host.flowsummary.inbytes = this.sumBytes(sum);

        let uploadPromiseList = [this.getLast24HoursUploadsStats(mac)]; // the reason why a single element list is used here is same as the one above.

        return Promise.all(uploadPromiseList)
          .then((results) => {
            let sum2 = this.sumFlows(results);
            let legacyFormat2 = this.flowToLegacyFormat(sum2);
            host.flowsummary.flowoutbytes = legacyFormat2;
            host.flowsummary.outbytes = this.sumBytes(sum2);
          });
      });  
  }
  
    getStats(target,type,from,to,callback) {
      let outdb = {};
      let indb = {};
      let inbytes = 0;
      let outbytes = 0;
      let lotsofkeys = 24*30*6;  //half months ... of data 
      log.debug("Getting stats:",type,target,from,to);

      let multi = rclient.multi();

      let len = iplist.length;

      let inkey = "stats:"+type+":in:"+target;
      let outkey = "stats:"+type+":out:"+target;
        
      multi.zscan(inkey, 0, 'count', lotsofkeys);
      multi.zscan(outkey, 0, 'count', lotsofkeys);

      multi.exec((err, results) => {

        if(err) {
          log.error("Failed to get stats from db: " + err);
          callback(err);
          return;
        }
        
        for(var i = 0; i < results.length; i++) {
          if(i%2 === 0) {
            inbytes += this.parseGetStatsResult(results[i], indb, from);
          } else {
            outbytes += this.parseGetStatsResult(results[i], outdb, to);
          }
        }

        let tsnow = Math.ceil(Date.now()/1000);
        tsnow = tsnow-tsnow%3600;
        let flowdata = {tophour:tsnow, from:from, to:to,type:type, flowinbytes:[], flowoutbytes:[],inbytes:inbytes,outbytes:outbytes};
        
        let keys = Object.keys(outdb); // or loop over the object to get the array
        keys.sort().reverse(); // maybe use custom sort, to change direction use .reverse()
        for (let i=0; i<keys.length; i++) { // now lets iterate in sort order
          let key = keys[i];
          flowdata.flowoutbytes.push({size:outdb[key],ts:keys[i]});
        }  
        keys = Object.keys(indb); // or loop over the object to get the array
        keys.sort().reverse(); // maybe use custom sort, to change direction use .reverse()
        for (let i=0; i<keys.length; i++) { // now lets iterate in sort order
          let key = keys[i];
          flowdata.flowinbytes.push({size:indb[key],ts:keys[i]});
        }  
        //log.info("FLOW DATA IS: ",flowdata,outdb,indb);
        callback(err, flowdata);
      });
    }

    // 
    // {
    //    mostflow: { flow:, std:}
    //    leastflow: { flow:,std:}
    //    total:
    // }   
    // 
    // tx here means to outside
    // rx means inside
    getFlowCharacteristics(_flows, direction, minlength, sdv) {
        log.debug("====== Calculating Flow spec of flows", _flows.length, direction, minlength, sdv);
        if (minlength == null) {
            minlength = 500000;
        }
        if (sdv == null) {
            sdv = 4;
        }
        if (_flows.length <= 0) {
            return null;
        }

        let flowspec = {};
        let flows = [];
        flowspec.direction = direction;
        flowspec.txRanked = [];
        flowspec.rxRanked = [];
        flowspec.txRatioRanked = [];

        let txratios = [];
        let rxvalues = [];
        let txvalues = [];
        let shostSummary = {};
        let dhostSummary = {};
        for (let i in _flows) {
            let flow = _flows[i];
            if (flow.rb < minlength && flow.ob < minlength) {
                continue;
            }
            flows.push(flow);

            if (flow.fd == "in") {
                txvalues.push(flow.ob);
            } else if (flow.fd == "out") {
                txvalues.push(flow.rb);
            }
            if (flow.fd == "in") {
                rxvalues.push(flow.rb);
            } else if (flow.fd == "out") {
                rxvalues.push(flow.ob);
            }
            let shost = shostSummary[flow.sh];
            let dhost = dhostSummary[flow.dh];
            if (shost) {
                shost.ob += flow.ob;
                shost.rb += flow.rb;
            } else {
                shostSummary[flow.sh] = {
                    ob: flow.ob,
                    rb: flow.rb
                };
            }
            if (dhost) {
                dhost.ob += flow.ob;
                dhost.rb += flow.rb;
            } else {
                dhostSummary[flow.dh] = {
                    ob: flow.ob,
                    rb: flow.rb
                };
            }

            if (flow.fd == "in") {
                flow.txratio = flow.ob / flow.rb;
                if (flow.rb == 0) {
                    flow.txratio = Math.min(flow.ob, 10); // ???
                }
            } else if (flow.fd == "out") {
                flow.txratio = flow.rb / flow.ob;
                if (flow.ob == 0) {
                    flow.txratio = Math.min(flow.rb); // ???
                }
            } else {
                log.error("FlowManager:FlowSummary:Error", flow);
            }
            txratios.push(flow.txratio);
        }


        if (flows.length <= 1) {
            // Need to take care of this condition
            log.debug("FlowManager:FlowSummary", "not enough flows");
            if (flows.length == 1) {
                flowspec.rxRanked.push(flows[0]);
                flowspec.txRanked.push(flows[0]);
                if (flows[0].txratio > 1.5) {
                    flowspec.txRatioRanked.push(flows[0]);
                }
                flowspec.onlyflow = true;
            }
            return flowspec;
        }

        flowspec.txStdev = stats.stdev(txvalues);
        flowspec.rxStdev = stats.stdev(rxvalues);
        flowspec.txratioStdev = stats.stdev(txratios)

        if (flowspec.txStdev == 0) {
            flowspec.txStdev = 1;
        }
        if (flowspec.rxStdev == 0) {
            flowspec.rxStdev = 1;
        }
        if (flowspec.txratioStdev == 0) {
            flowspec.txratioStdev = 1;
        }

        log.debug("txStd Deviation", flowspec.txStdev);
        log.debug("rxStd Deviation", flowspec.rxStdev);
        log.debug("txRatioStd Deviation", flowspec.txratioStdev);
        for (let i in flows) {
            let flow = flows[i];
            if (flow.fd == "in") {
                flow['rxStdev'] = flow.rb / flowspec.rxStdev;
                flow['txStdev'] = flow.ob / flowspec.txStdev;
                flow['txratioStdev'] = flow.txratio / flowspec.txratioStdev;
            } else if (flow.fd == "out") {
                flow['rxStdev'] = flow.ob / flowspec.txStdev;
                flow['txStdev'] = flow.rb / flowspec.rxStdev;
                flow['txratioStdev'] = flow.txratio / flowspec.txratioStdev;
            }
        }

        flows.sort(function (a, b) {
            return Number(b['rxStdev']) - Number(a['rxStdev']);
        })
        let max = 5;
        log.debug("RX ");
        for (let i in flows) {
            let flow = flows[i];
            if (flow.rxStdev < sdv) {
                continue;
            }
            log.debug(flow,{});
            flowspec.rxRanked.push(flow);
            max--;
            if (max < 0) {
                break;
            }
        }
        flows.sort(function (a, b) {
            return Number(b['txStdev']) - Number(a['txStdev']);
        })
        max = 5;
        log.debug("TX ");
        for (let i in flows) {
            let flow = flows[i];
            if (flow.txStdev < sdv) {
                continue;
            }
            log.debug(flow,{});
            flowspec.txRanked.push(flow);
            max--;
            if (max < 0) {
                break;
            }
        }
        flows.sort(function (a, b) {
            return Number(b['txratioStdev']) - Number(a['txratioStdev']);
        })
        max = 5;
        log.debug("TX Ratio");
        for (let i in flows) {
            let flow = flows[i];
            if (flow.txratioStdev < sdv || flow.txratio < 1) {
                continue;
            }
            log.debug(flow,{});
            flowspec.txRatioRanked.push(flow);
            max--;
            if (max < 0) {
                break;
            }
        }

        return flowspec;

        //     log.info("ShostSummary", shostSummary, "DhostSummary", dhostSummary);

    }

    /* given a list of flows, break them down to conversations
     *  
     * produce a summary of flows like
     *   {::flow:: + duration } ...
     */
    getAppSummary(flow, callback) {

    }

    summarizeHostBytes(host,from,to,block,callback) {
            const target = host.o.mac;
            host.flowsummary = {};
            host.flowsummary.inbytes = 0;
            host.flowsummary.outbytes = 0;
            this.getStats(target,block,from,to,callback);
    }

    summarizeBytes2(hosts,from,to,block,callback) {
        _async.eachLimit(hosts, 1, (host, cb) => {
            this.summarizeHostBytes(host,from,to,block,(err,data)=>{
                host.flowsummary = data;
                cb();
            });
        },(err) => {
            callback(null,null);
        });
    }

    async summarizeActivityFromConnections(flows) {
        let appdb = {};
        let activitydb = {};

        for (let i in flows) {
            let flow = flows[i];
            if (flow.du<flowconfig.activityDetectMin) {
                continue;
            }
            if (flow.du>flowconfig.activityDetectMax) {
                continue;
            }
            if (flow.flows) {
                 let fg = new FlowGraph("raw");
                 //log.info("$$$ Before",flow.flows);
                 for (let i in flow.flows) {
                       let f = flow.flows[i];
                       let count = f[4];
                       if (count ==null) {
                           count =1;
                       }
                       fg.addRawFlow(f[0],f[1],f[2],f[3],count);
                 }
                 flow.flows = fg.flowarray;
                 //log.info("$$$ After",flow.flows);
            }
            if (flow.appr) {
                if (appdb[flow.appr]) {
                    appdb[flow.appr].push(flow);
                } else {
                    appdb[flow.appr] = [flow];
                }
            } else if (flow.intel && flow.intel.category && flow.intel.category!="intel") {
                if (activitydb[flow.intel.category]) {
                    activitydb[flow.intel.category].push(flow);
                } else {
                    activitydb[flow.intel.category] = [flow];
                }
            }
        }

/*
        onsole.log("--------------appsdb ---- ");
        log.info(appdb);
        log.info("--------------activitydb---- ");
        log.info(activitydb);
*/
        //log.info(activitydb);
 
        let flowobj = {id:0,app:{},activity:{}};
        let hasFlows = false;

        for (let i in appdb) {
            let f = new FlowGraph(i);
            for (let j in appdb[i]) {
                f.addFlow(appdb[i][j]);
                hasFlows = true;
            }
            // f.name is i, which is the name of app
            flowobj.app[f.name]= f.flowarraySorted(true);
            for (let k in flowobj.app[f.name]) {
                let _f = flowobj.app[f.name][k];
            }
        }
        for (let i in activitydb) {
            let f = new FlowGraph(i);
            for (let j in activitydb[i]) {
                f.addFlow(activitydb[i][j]);
                hasFlows = true;
            }
            flowobj.activity[f.name]=f.flowarraySorted(true);;
            for (let k in flowobj.activity[f.name]) {
                let _f = flowobj.activity[f.name][k];
            }
         
        }
        // linear these flows
       
        if (!hasFlows) {
            return null;
        }

        //log.info("### Cleaning",flowobj);

        return new Promise((resolve, reject) => {
          bone.flowgraph("clean", [flowobj],(err,data)=>{
            resolve(data);
          });
        });
    }

    
    isFlowValid(flow) {
      let o = flow;
      
      if (o == null) {
        log.error("Host:Flows:Sorting:Parsing", flow);
        return false;
      }
      if (o.rb == null || o.ob == null) {
        return false
      }
      if (o.rb == 0 && o.ob ==0) {
        // ignore zero length flows
        return false;
      }
      if (o.f === "s") {
        // short packet flag, maybe caused by arp spoof leaking, ignore these packets 
        return false;
      }
      
      return true;
    }
    
    flowStringToJSON(flow) {
      try {
        return JSON.parse(flow);
      } catch(err) {
        return null;
      }
    }
       
    mergeFlow(targetFlow, flow) {
      targetFlow.rb += flow.rb;
      targetFlow.ct += flow.ct;
      targetFlow.ob += flow.ob;
      targetFlow.du += flow.du;
      if (targetFlow.ts < flow.ts) {
        targetFlow.ts = flow.ts;
      }
      if (flow.pf) {
        for (let k in flow.pf) {
          if (targetFlow.pf[k] != null) {
            targetFlow.pf[k].rb += flow.pf[k].rb;
            targetFlow.pf[k].ob += flow.pf[k].ob;
            targetFlow.pf[k].ct += flow.pf[k].ct;
          } else {
            targetFlow.pf[k] = flow.pf[k]
          }
        }
      }
      if (flow.flows) {
        if (targetFlow.flows) {
          targetFlow.flows = targetFlow.flows.concat(flow.flows);
        } else {
          targetFlow.flows = flow.flows;
        }
      }
    }
    
    // append to existing flow or create new
    appendFlow(conndb, flowObject) {
      let o = flowObject;
      
      let key = "";
      if (o.sh == o.lh) {
        key = o.dh + ":" + o.fd;
      } else {
        key = o.sh + ":" + o.fd;
      }
      //     let key = o.sh+":"+o.dh+":"+o.fd;
      let flow = conndb[key];
      if (flow == null) {
        conndb[key] = JSON.parse(JSON.stringify(o));  // this object may be presented multiple times in conndb due to different dst ports. Copy is needed to avoid interference between each other.
      } else {
        this.mergeFlow(flow, o);
      }
    }   
  
    // conns in last 24 hours
    // 2018.11.13 This function is not used
    recentOutgoingConnections(mac, interval) {
      interval = interval || 3600 * 24;
      
      let key = "flow:conn:in:" + mac;
      let to = new Date() / 1000;
      let from = to - interval;
      
      return rclient.zrevrangebyscoreAsync([key, to, from, "LIMIT", 0 , QUERY_MAX_FLOW])
        .then((results) => {
        
        if(results === null || results.length === 0)
          return [];
        
        let flowObjects = results
                            .map((x) => this.flowStringToJSON(x))
                            .filter((x) => this.isFlowValid(x));
        
        let conndb = {};
        
        flowObjects.forEach((flowObject) => {
          this.appendFlow(conndb, flowObject);  
        });
        
        let connArray = [];
        
        for(let i in conndb) {
          connArray.push(conndb[i]);
        }
        
        return connArray;
        
        }).catch((err) => {
        log.error("Failed to query flow data for ip", ip, ":", err, err.stack, {});
        return;
      });
    }
    
  async summarizeConnections(mac, direction, from, to, sortby, hours, resolve, saveStats) {
    let sorted = [];
    try {
      let key = "flow:conn:" + direction + ":" + mac;
      const result = await rclient.zrevrangebyscoreAsync([key, from, to, "LIMIT", 0, QUERY_MAX_FLOW]);
      let conndb = {};
      let interval = 0;
      let totalInBytes = 0;
      let totalOutBytes = 0;

      if (result != null && result.length > 0)
        log.debug("### Flow:Summarize", key, direction, from, to, sortby, hours, resolve, saveStats, result.length);
      for (let i in result) {
        let o = JSON.parse(result[i]);

        if (!this.isFlowValid(o))
          continue;

        if (saveStats) {
          if (direction == 'in') {
            totalInBytes += Number(o.rb);
            totalOutBytes += Number(o.ob);
            // use end timestamp to record stats, so that connection which lasts more than 24 hours will still be recorded 
            this.recordStats(mac, "hour", o.ets ? o.ets : o.ts, Number(o.rb), Number(o.ob), null);
          } else {
            totalInBytes += Number(o.ob);
            totalOutBytes += Number(o.rb);
            this.recordStats(mac, "hour", o.ets ? o.ets : o.ts, Number(o.ob), Number(o.rb), null);
          }
        }
        let ts = o.ts;
        if (o._ts) {
          ts = o._ts;
        }
        if (interval == 0 || ts < interval) {
          if (interval == 0) {
            interval = Date.now() / 1000;
          }
          interval = interval - hours * 60 * 60;
          for (let j in conndb) {
            sorted.push(conndb[j]);
          }
          conndb = {};
        }
        let key = "";
        if (o.pf) {
          for (let k in o.pf) {
            // aggregate by dst host and dst port and direction
            if (o.sh == o.lh) {
              key = o.dh + ":" + o.fd + ":" + k;
            } else {
              key = o.sh + ":" + o.fd + ":" + k;
            }
            let flow = conndb[key];
            if (flow == null) {
              conndb[key] = JSON.parse(JSON.stringify(o));  // this object may be presented multiple times in conndb due to different dst ports. Copy is needed to avoid interference between each other. The devil is in the details!!
              flow = conndb[key];
              let dp = k.split("\.", 2).slice(-1)[0];
              // double check to ensure that k is <proto>.<port_number>
              if (/^\d+$/.test(dp)) {
                // flow.dp already exists in temp flow spec, 
                // however overriding dp here should do no harm
                // in case of stashed flow spec, dp can be parsed from port flow
                // therefore in most cases, dp should be included in summarized flow
                flow.dp = dp;
              }
              flow.rb = o.pf[k].rb;
              flow.ct = o.pf[k].ct;
              flow.ob = o.pf[k].ob;
              flow.du = o.du;
              if (o.pf[k].sp) {
                flow.sp_array = o.pf[k].sp;
              }
            } else {
              // use rb, ob and ct in port flow since key contains dst port
              flow.rb += o.pf[k].rb;
              flow.ct += o.pf[k].ct;
              flow.ob += o.pf[k].ob;
              flow.du += o.du;
              if (flow.ts < o.ts) {
                flow.ts = o.ts;
              }
              if (o.pf[k].sp) {
                if (flow.sp_array) {
                  flow.sp_array = flow.sp_array.concat(o.pf[k].sp);
                } else {
                  flow.sp_array = o.pf[k].sp;
                }
              }
              // NOTE: flow.flows will be removed in FlowTool.trimFlow...
              if (o.flows) {
                if (flow.flows) {
                  flow.flows = flow.flows.concat(o.flows);
                } else {
                  flow.flows = o.flows;
                }
              }
            }
            // NOTE: flow.pf will be removed in flowTool.trimFlow...
            if (flow.pf[k] != null) {
              flow.pf[k].rb += o.pf[k].rb;
              flow.pf[k].ob += o.pf[k].ob;
              flow.pf[k].ct += o.pf[k].ct;
            } else {
              flow.pf[k] = o.pf[k]
            }
          }
        } else {
          if (o.sh == o.lh) {
            key = o.dh + ":" + o.fd;
          } else {
            key = o.sh + ":" + o.fd;
          }
          //     let key = o.sh+":"+o.dh+":"+o.fd;
          let flow = conndb[key];
          if (flow == null) {
            conndb[key] = o;
          } else {
            flow.rb += o.rb;
            flow.ct += o.ct;
            flow.ob += o.ob;
            flow.du += o.du;
            if (flow.ts < o.ts) {
              flow.ts = o.ts;
            }
            // NOTE: flow.flows will be removed in FlowTool.trimFlow...
            if (o.flows) {
              if (flow.flows) {
                flow.flows = flow.flows.concat(o.flows);
              } else {
                flow.flows = o.flows;
              }
            }
          }
        }
      }

      if (saveStats) {
        let _ts = Math.ceil(Date.now() / 1000);
        // Date.now() is used here, which looks inconsistent with per device recordStats, nevertheless the traffic end timestamp and Date.now() should be close
        this.recordStats("0.0.0.0", "hour", _ts, totalInBytes, totalOutBytes, null);
      }

      for (let m in conndb) {
        sorted.push(conndb[m]);
      }

      // trim to reduce size
      sorted.forEach(flowTool.trimFlow);

      if (result.length > 0)
        log.debug("### Flow:Summarize", key, direction, from, to, sortby, hours, resolve, saveStats, result.length, totalInBytes, totalOutBytes);
      conndb = {};
    } catch (err) {
      log.error("Flow Manager Error");
      return {
        connections: sorted,
        activities: null
      };
    }
    log.debug("============ Host:Flows:Sorted", sorted.length);
    if (sortby == "time") {
      sorted.sort(function (a, b) {
        return Number(b.ts) - Number(a.ts);
      })
    } else if (sortby == "rxdata") {
      sorted.sort(function (a, b) {
        return Number(b.rb) - Number(a.rb);
      })
    } else if (sortby == "txdata") {
      sorted.sort(function (a, b) {
        return Number(b.ob) - Number(a.ob);
      })
    }

    if (resolve == true) {
      log.debug("flows:sorted Query dns manager");
      return new Promise((resolve, reject) => {
        dnsManager.query(sorted, "sh", "dh", (err) => {
          if (err != null) {
            log.error("flow:conn unable to map dns", err);
          }
          log.debug("flows:sorted Query dns manager returnes");
          (async () => {
            const activities = await this.summarizeActivityFromConnections(sorted);
            //log.info("Activities",activities);
            let _sorted = [];
            for (let i in sorted) {
              if (flowUtil.checkFlag(sorted[i], 'x')) {
                //log.info("DroppingFlow",sorted[i]); 
              } else {
                _sorted.push(sorted[i]);
              }
            }
            resolve({
              connections: _sorted,
              activities: activities
            });
          })();
        });
      });
    } else {
      return {
        connections: sorted,
        activities: null
      };
    }
  }

    toStringShort(obj) {
        //  // "{\"ts\":1464328076.816846,\"sh\":\"192.168.2.192\",\"dh\":\"224.0.0.251\",\"ob\":672001,\"rb\":0,\"ct\":1,\"fd\":\"in\",\"lh\":\"192.168.2.192\",\"bl\":3600}"
        let ts = Date.now() / 1000;
        let t = ts - obj.ts
        t = (t / 60).toFixed(1);
        let _ts = Date.now() / 1000;
        let _t = _ts - obj._ts
        _t = (_t / 60).toFixed(1);
        let org = "";
        if (obj.org) {
            org = "(" + obj.org + ")";
        }
        let appr = "";
        if (obj.appr) {
            appr = "#" + obj.appr + "#";
        }
        return t+"("+_t+")" + "\t" + obj.du + "\t" + obj.sh + "\t" + obj.dh + "\t" + obj.ob + "\t" + obj.rb + "\t" + obj.ct + "\t" + obj.shname + "\t" + obj.dhname + org + appr;
    }

    toStringShortShort2(obj, type, interest) {
        let sname = obj.sh;
        if (obj.shname) {
            sname = obj.shname;
        }
        let name = obj.dh;
        if (type == 'txdata' || type =='out') {
            if (obj.appr && obj.appr.length > 2) {
                name = obj.appr;
            } else if (obj.dhname && obj.dhname.length > 2) {
                name = obj.dhname;
            }
        } else {
            if (obj.appr && obj.appr.length > 2) {
                name = obj.appr;
            } else if (obj.org && obj.org.length > 2) {
                name = obj.org;
            } else if (obj.dhname && obj.dhname.length > 2) {
                name = obj.dhname;
            }
        }

        //let time = Math.round((Date.now() / 1000 - obj.ts) / 60);
        let time = Math.round((Date.now() / 1000 - obj.ts) / 60);
        let dtime = "";

        if (time>5) {
            dtime = time+" min ago, ";
        }

        if (type == null) {
            return name + "min : rx " + obj.rb + ", tx " + obj.ob;
        } else if (type == "rxdata" || type == "in") {
            if (interest == 'txdata') {
                return dtime+sname + " transferred to " + name + " [" + obj.ob + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
            }
            return dtime+sname + " transferred to " + name + " " + obj.ob + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
        } else if (type == "txdata" || type == "out") {
            if (interest == 'txdata') {
                return dtime+sname + " transferred to " + name + " : [" + obj.rb + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
            }
            return dtime+sname + " transferred to " + name + ", " + obj.rb + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
        }
    }

    toStringShortShort(obj, type) {
        let sname = obj.sh;
        if (obj.shname) {
            sname = obj.shname;
        }
        let name = obj.dh;
        if (obj.appr && obj.appr.length > 2) {
            name = obj.appr;
        } else if (obj.org && obj.org.length > 2) {
            name = obj.org;
        } else if (obj.dhname && obj.dhname.length > 2) {
            name = obj.dhname;
        }

        let time = Math.round((Date.now() / 1000 - obj.ts) / 60);

        if (type == null) {
            return name + "min : rx " + obj.rb + ", tx " + obj.ob;
        } else if (type == "rxdata") {
            return time + "min: " + sname + "->" + name + " " + obj.rb + " bytes";
        } else if (type == "txdata") {
            return time + "min: " + sname + "->" + name + " : " + obj.ob + " bytes";
        }
    }

    sort(sorted, sortby) {
        if (sortby == "time") {
            sorted.sort(function (a, b) {
                return Number(b.ts) - Number(a.ts);
            })
        } else if (sortby == "rxdata") {
            sorted.sort(function (a, b) {
                return Number(b.rb) - Number(a.rb);
            })
        } else if (sortby == "txdata") {
            sorted.sort(function (a, b) {
                return Number(b.ob) - Number(a.ob);
            })
        } else if (sortby == "duration") {
            sorted.sort(function (a, b) {
                return Number(b.du) - Number(a.du);
            })
        }
        return sorted;
    }

  removeFlowsAll(mac) {
    // flow:http & flow:ssl & stats:day & stats:month seem to be deprecated

    let keys = [
      'flow:conn:in:' + mac,
      'flow:conn:out:' + mac,
      'stats:hour:in:' + mac,
      'stats:hour:out:' + mac,
      'stats:last24:' + mac + ':upload',
      'stats:last24:' + mac + ':download',
    ];

    return rclient.delAsync(keys);
  }
}
