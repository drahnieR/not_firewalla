/*    Copyright 2016-2024 Firewalla Inc.
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
'use strict'

let chai = require('chai');
let expect = chai.expect;
const execAsync = require('child-process-promise').exec;

const fireRouter = require('../net2/FireRouter.js');
const Host = require('../net2/Host.js');
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();
const log = require('../net2/logger.js')(__filename);
const NetworkProfile = require('../net2/NetworkProfile.js');
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const npm = require('../net2/NetworkProfileManager.js');
const sysManager = require('../net2/SysManager.js');
const Tag = require('../net2/Tag.js');
const tagManager = require('../net2/TagManager.js');
const InternalScanSensor = require('../sensor/InternalScanSensor.js');
const rclient = require('../util/redis_manager.js').getRedisClient();

const policyKeyName = 'weak_password_scan';

const bruteConfig =  {
  "tcp_23": {
    "serviceName": "TELNET",
    "protocol": "tcp",
    "port": 23,
    "scripts": [{
      "scriptName": "telnet-brute",
      "otherArgs": "-v"
    }]
  },
  "tcp_53": {
    "serviceName": "DNS",
    "protocol": "udp",
    "port": 53,
    "scripts": [{
      "scriptName": "telnet-brute"
    }]
  },
  "tcp_80": {
    "serviceName": "HTTP",
    "protocol": "tcp",
    "port": 80,
    "scripts": [
      {
        "scriptArgs": "unpwdb.timelimit=60m",
        "scriptName": "http-brute"
      },
      {
        "scriptArgs": "unpwdb.timelimit=60m",
        "scriptName": "http-form-brute"
      }
    ]
}}

const extraConfig = {
  'http-form-brute': [{},{path: '/oauth', passvar: 'token', uservar: 'username'}, {uservar: 'name'}],
};

describe('Test InternalScanSensor', function() {
  this.timeout(1200000);
  this.plugin = new InternalScanSensor({});
  this.plugin.subTaskMap = {};
  this.plugin.subTaskRunning = {};
  this.plugin.scheduledScanTasks = {};
  this.plugin.subTaskWaitingQueue = [];

  beforeEach((done) => {
    done();
  });

  afterEach((done) => {
    done();
  });

  it('should process', async() =>{
    await this.plugin._process_dict_creds({});

    const data = {
      customCreds:{ftp:{},telnet:{},mysql:{},redis:{},
        ssh:{usernames:['pi'],passwords:['raspberry','firewalla']},
        http:{usernames:['firewalla'],passwords:['admin123']}
      },
      commonCreds: {
        usernames:['admin','username','user'], passwords:['','firewalla','123456','12345'],
        creds:[{user:'root',password:'ubuntu'}]
      }
    };
    await this.plugin._process_dict_creds(data);

    const usercount = await execAsync('grep -c "" ~/.firewalla/run/scan_config/ssh_users.lst');
    expect(usercount.stdout.trim()).to.be.equal('4');
    const passcount = await execAsync('grep -c "" ~/.firewalla/run/scan_config/ssh_pwds.lst');
    expect(passcount.stdout.trim()).to.be.equal('5');
    const credcount = await execAsync('grep -c "" ~/.firewalla/run/scan_config/ssh_creds.lst');
    expect(credcount.stdout.trim()).to.be.equal('1');

  });


  it('should process dictionary extras', async()=> {
    await this.plugin._process_dict_extras(null);

    const extras = {
      'http-form-brute': [{path: '/oauth'}, {uservar: 'name'}],
    };
  
    await this.plugin._process_dict_extras(extras);

    const data = await rclient.hgetAsync('sys:config', 'weak_password_scan');
    expect(data).to.be.equal('{"http-form-brute":[{"path":"/oauth"},{"uservar":"name"}]}');
  });


  describe('should format nmap command', () => {
    it('should format nmap with scripts args', () => {
      let cmdArg = ['--script test-brute'];
      let scriptArgs = ['unpwdb.timelimit=90m,brute.firstonly=true', 'userdb=', 'passdb='];
      const command = this.plugin.formatNmapCommand('192.168.196.1', 22, cmdArg, scriptArgs);
      expect(command).to.be.eql('sudo timeout 5430s nmap -p 22 --script test-brute --script-args unpwdb.timelimit=90m,brute.firstonly=true,userdb=,passdb= 192.168.196.1 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64');
    });

    it('should format nmap without scripts args', () => {
      let cmdArg = ['--script test-brute'];
      const command = this.plugin.formatNmapCommand('192.168.196.1', 22, cmdArg, []);
      expect(command).to.be.eql('sudo timeout 5430s nmap -p 22 --script test-brute 192.168.196.1 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64');
    });
  });

  it('should multiply script args', () => {
    let scriptArgs = ['unpwdb.timelimit=90m,brute.firstonly=true'];
    let extras = [{path: '/auth', method: 'GET', uservar: 'user', passvar: 'pass'},{path: '/login'},{uservar: 'user', passvar: 'pass'}];
    const results = InternalScanSensor.multiplyScriptArgs(scriptArgs, extras);
    const exp = [
      ['unpwdb.timelimit=90m,brute.firstonly=true', 'http-form-brute.path=/auth', 'http-form-brute.method=GET', 'http-form-brute.uservar=user', 'http-form-brute.passvar=pass'],
      ['unpwdb.timelimit=90m,brute.firstonly=true', 'http-form-brute.path=/login'],
      ['unpwdb.timelimit=90m,brute.firstonly=true', 'http-form-brute.uservar=user', 'http-form-brute.passvar=pass'],
    ]
    expect(results).to.be.eql(exp);
  });

  it('should generate nmap default', async() => {
    const httpcmds = await this.plugin._genNmapCmd_default('192.168.196.105', 80, bruteConfig['tcp_80'].scripts);
    expect(httpcmds.map(i=>i.cmd)).to.eql([
      'sudo timeout 5430s nmap -p 80 --script http-brute --script-args unpwdb.timelimit=60m 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
      'sudo timeout 5430s nmap -p 80 --script http-form-brute --script-args unpwdb.timelimit=60m 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
    ]);

    const telcmds = await this.plugin._genNmapCmd_default('192.168.196.105', 23, bruteConfig['tcp_23'].scripts);
    expect(telcmds.map(i=>i.cmd)).to.eql([
      'sudo timeout 5430s nmap -p 23 --script telnet-brute -v 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
    ]);

    this.plugin.config = {strict_http: true};
    await execAsync("cp /usr/share/nmap/scripts/http-brute.nse /home/pi/.firewalla/run/assets/http-brute.nse;");
    const customhttpcmds = await this.plugin._genNmapCmd_default('192.168.196.105', 80, bruteConfig['tcp_80'].scripts);
    expect(customhttpcmds.map(i=>i.cmd)).to.eql([
      'sudo timeout 5430s nmap -p 80 --script /home/pi/.firewalla/run/assets/http-brute.nse --script-args unpwdb.timelimit=60m 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
      'sudo timeout 5430s nmap -p 80 --script http-form-brute --script-args unpwdb.timelimit=60m 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
    ]);

    this.plugin.config = {};
  });

  it('should generate nmap credfile', async () => {
    const httpcmds = await this.plugin._genNmapCmd_credfile('192.168.196.105', 80, 'HTTP', bruteConfig['tcp_80'].scripts, extraConfig);
    expect(httpcmds.map(i=>i.cmd)).to.eql([
      'sudo timeout 5430s nmap -p 80 --script http-brute --script-args unpwdb.timelimit=60m,brute.mode=creds,brute.credfile=/home/pi/.firewalla/run/scan_config/http_creds.lst 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
      'sudo timeout 5430s nmap -p 80 --script http-form-brute --script-args unpwdb.timelimit=60m,brute.mode=creds,brute.credfile=/home/pi/.firewalla/run/scan_config/http_creds.lst 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
      'sudo timeout 5430s nmap -p 80 --script http-form-brute --script-args unpwdb.timelimit=60m,brute.mode=creds,brute.credfile=/home/pi/.firewalla/run/scan_config/http_creds.lst,http-form-brute.path=/oauth,http-form-brute.uservar=username,http-form-brute.passvar=token 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
      'sudo timeout 5430s nmap -p 80 --script http-form-brute --script-args unpwdb.timelimit=60m,brute.mode=creds,brute.credfile=/home/pi/.firewalla/run/scan_config/http_creds.lst,http-form-brute.uservar=name 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
    ]);

    const httpbrutecmds = await this.plugin._genNmapCmd_credfile('192.168.196.105', 80, 'HTTP', bruteConfig['tcp_80'].scripts, null);
    expect(httpbrutecmds.map(i=>i.cmd)).to.eql([
      'sudo timeout 5430s nmap -p 80 --script http-brute --script-args unpwdb.timelimit=60m,brute.mode=creds,brute.credfile=/home/pi/.firewalla/run/scan_config/http_creds.lst 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
      'sudo timeout 5430s nmap -p 80 --script http-form-brute --script-args unpwdb.timelimit=60m,brute.mode=creds,brute.credfile=/home/pi/.firewalla/run/scan_config/http_creds.lst 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
    ]);

    const telcmds = await this.plugin._genNmapCmd_credfile('192.168.196.105', 23, 'TELNET', bruteConfig['tcp_23'].scripts);
    expect(telcmds.map(i=>i.cmd)).to.eql([
      'sudo timeout 5430s nmap -p 23 --script telnet-brute -v --script-args brute.mode=creds,brute.credfile=/home/pi/.firewalla/run/scan_config/telnet_creds.lst 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64'
    ]);

    const nocmds = await this.plugin._genNmapCmd_credfile('192.168.196.105', 53, 'DNS', bruteConfig['tcp_53'].scripts);
    expect(nocmds.length).to.equal(0);
  });

  it('should generate nmap userpass', async () => {
    const httpcmds = await this.plugin._genNmapCmd_userpass('192.168.196.105', 80, 'HTTP', bruteConfig['tcp_80'].scripts, extraConfig);
    expect(httpcmds.map(i=>i.cmd)).to.eql([
      'sudo timeout 5430s nmap -p 80 --script http-brute --script-args unpwdb.timelimit=60m,userdb=/home/pi/.firewalla/run/scan_config/http_users.lst,passdb=/home/pi/.firewalla/run/scan_config/http_pwds.lst 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
      'sudo timeout 5430s nmap -p 80 --script http-form-brute --script-args unpwdb.timelimit=60m,userdb=/home/pi/.firewalla/run/scan_config/http_users.lst,passdb=/home/pi/.firewalla/run/scan_config/http_pwds.lst 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
      'sudo timeout 5430s nmap -p 80 --script http-form-brute --script-args unpwdb.timelimit=60m,userdb=/home/pi/.firewalla/run/scan_config/http_users.lst,passdb=/home/pi/.firewalla/run/scan_config/http_pwds.lst,http-form-brute.path=/oauth,http-form-brute.uservar=username,http-form-brute.passvar=token 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
      'sudo timeout 5430s nmap -p 80 --script http-form-brute --script-args unpwdb.timelimit=60m,userdb=/home/pi/.firewalla/run/scan_config/http_users.lst,passdb=/home/pi/.firewalla/run/scan_config/http_pwds.lst,http-form-brute.uservar=name 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
    ]);

    const httpbrutecmds = await this.plugin._genNmapCmd_userpass('192.168.196.105', 80, 'HTTP', bruteConfig['tcp_80'].scripts);
    expect(httpbrutecmds.map(i=>i.cmd)).to.eql([
      'sudo timeout 5430s nmap -p 80 --script http-brute --script-args unpwdb.timelimit=60m,userdb=/home/pi/.firewalla/run/scan_config/http_users.lst,passdb=/home/pi/.firewalla/run/scan_config/http_pwds.lst 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
      'sudo timeout 5430s nmap -p 80 --script http-form-brute --script-args unpwdb.timelimit=60m,userdb=/home/pi/.firewalla/run/scan_config/http_users.lst,passdb=/home/pi/.firewalla/run/scan_config/http_pwds.lst 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64',
    ]);


    const telcmds = await this.plugin._genNmapCmd_userpass('192.168.196.105', 23, 'TELNET', bruteConfig['tcp_23'].scripts);
    expect(telcmds.map(i=>i.cmd)).to.eql([
      'sudo timeout 5430s nmap -p 23 --script telnet-brute -v --script-args userdb=/home/pi/.firewalla/run/scan_config/telnet_users.lst,passdb=/home/pi/.firewalla/run/scan_config/telnet_pwds.lst 192.168.196.105 -oX - | /home/pi/firewalla/extension/xml2json/xml2json.x86_64'
    ]);

    const nocmds = await this.plugin._genNmapCmd_userpass('192.168.196.105', 53, 'DNS', bruteConfig['tcp_53'].scripts);
    expect(nocmds.length).to.equal(0);
  });

  it('should nmap guess passwords', async() => {
    this.plugin.config = {skip_verify: false};
    this.plugin.subTaskMap['hostId'] = {};
    let weakPasswords = await this.plugin.nmapGuessPassword('127.0.0.1', bruteConfig['tcp_80'], 'hostId');
    expect(weakPasswords).to.be.empty;

    this.plugin.config = {skip_verify: true};
    weakPasswords = await this.plugin.nmapGuessPassword('127.0.0.1', bruteConfig['tcp_80'], 'hostId');
    expect(weakPasswords).to.be.empty;
  });

  it('should check http brute creds', async() => {
    const ret = await this.plugin.httpbruteCreds('127.0.0.1', 8080, 'admin', '<empty>', '/home/pi/.firewalla/run/scan_config/127.0.0.1_8080_credentials.lst');
    expect(ret).to.equal(false);
  });

  it('should recheck weak passwords', async() => {
    const result = await this.plugin.recheckWeakPassword('127.0.0.1', 8080, 'http-brute', {username: 'admin', password: '123456'});
    expect(result).to.equal(false);
  });

  it('should clean up local scan config redis', async() => {
    await rclient.hsetAsync('sys:config', 'weak_password_scan', '{"http-form-brute":[{"path":"/oauth"},{"uservar":"name"}]}').catch(
      (err) => {log.warn('hset err', err.stderr)});

    await this.plugin._cleanup_dict_extras();
    const data = await rclient.hgetAsync('sys:config', 'weak_password_scan');
    expect(data).to.be.null;
  });


  it('should clean up local scan config dir', async() => {
    await execAsync('touch /home/pi/.firewalla/run/scan_config/ssh_tests.lst /home/pi/.firewalla/run/scan_config/http_tests.lst /home/pi/.firewalla/run/scan_config/telnet_tests.lst').catch(
      (err) => {log.warn('touch err', err.stderr)});

    await this.plugin._clean_diff_creds('/home/pi/.firewalla/run/scan_config/', '_tests.lst', ['ssh_tests.lst']);
    const credFiles = await this.plugin._list_suffix_files('/home/pi/.firewalla/run/scan_config/', '_tests.lst');
    expect(credFiles).to.be.eql(['ssh_tests.lst']);
    await execAsync('rm -f /home/pi/.firewalla/run/scan_config/ssh_tests.lst').catch((err) => {});

    await this.plugin._cleanup_dict_creds();
    const files = await this.plugin._list_suffix_files('/home/pi/.firewalla/run/scan_config/', '.lst');
    expect(files).to.be.empty;
  });

  it('should check dictionary', async() => {
    await this.plugin.checkDictionary();
  });


  // A connected device is expected to run a http-server with basic-auth enabled
  // e.g. tiny-http-server --authfile userpass.txt --port 80 --bind 0.0.0.0 --directory html
  it.skip('should nmap guess passwords with weak password enviroment', async() => {
    this.plugin.config = {skip_verify: false};
    this.plugin.subTaskMap['hostId'] = {};
    let weakPasswords = await this.plugin.nmapGuessPassword('192.168.196.105', bruteConfig['tcp_80'], 'hostId');
    expect(weakPasswords).to.be.eql([{username: 'admin', password: '123456'}]);

    this.plugin.config = {skip_verify: true};
    weakPasswords = await this.plugin.nmapGuessPassword('192.168.196.105', bruteConfig['tcp_80'], 'hostId');
    expect(weakPasswords).to.be.eql([{username: 'admin', password: '123456'}]);
  });
});


function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

async function _setTargetPolicy(type, target, state) {
  const policyState = state != null ? {state: state} : undefined;
  switch (type) {
    case 'host': {
      const hostObj = await hostManager.getHostAsync(target, true);
      if (hostObj && hostObj.getUniqueId()) {
        await hostObj.setPolicyAsync(policyKeyName, policyState);
        return;
      }
      break;
    }
    case 'network': {
      const intfObj = networkProfileManager.getNetworkProfile(target);
      if (intfObj && intfObj.getUniqueId()) {
        await intfObj.setPolicyAsync(policyKeyName, policyState);
        return;
      }
      break;
    }
    case 'tag': {
      const tagObj = tagManager.getTag(target);
      if (tagObj && tagObj.getUniqueId()) {
        await tagObj.setPolicyAsync(policyKeyName, policyState);
        return;
      }
      break;
    }
    default:
      log.warn(`fail to set policy, unknown target type ${type}`);
      return;
  }
  log.warn(`fail to set policy, ${type} ${target} is not found`);
}


const cronPolicy = {cron:"10 10 * * *",state:true,defaultOn:true,includeVPNNetworks:false};


describe('Test applyPolicy', function(){
  this.timeout(10000);
  process.title = "FireMain"
  this.plugin = new InternalScanSensor({});
  this.plugin.subTaskMap = {};
  this.plugin.subTaskRunning = {};
  this.plugin.scheduledScanTasks = {};
  this.plugin.subTaskWaitingQueue = [];

  sysManager.uuidMap = {};
  sysManager.uuidMap["88888888-4881-4881-4881-488148812888"] = {"name": "eth0.288", "uuid": "88888888-4881-4881-4881-488148812888", "mac_address":"20:6D:31:01:2B:88"};
  sysManager.uuidMap["99999999-4881-4881-4881-488148812999"] = {"name": "eth0.289", "uuid": "99999999-4881-4881-4881-488148812999", "mac_address":"20:6D:31:01:2B:89"};

  this.hm = new HostManager();
  this.hm.hosts = {all:[]};

  beforeEach((done) => {
    (async() =>{
      fireRouter.scheduleReload();
      await delay(2000)
      await sysManager.updateAsync();
      const currentTs = Date.now() / 1000;
      npm.networkProfiles["88888888-4881-4881-4881-488148812888"] = new NetworkProfile({uuid: "88888888-4881-4881-4881-488148812888"});
      npm.networkProfiles["99999999-4881-4881-4881-488148812999"] = new NetworkProfile({uuid: "99999999-4881-4881-4881-488148812999"});
      tagManager.tags['88']= new Tag({uid: 88, name: '', createTs: currentTs});
      await rclient.hsetAsync('host:mac:20:6D:31:01:2B:88', 'mac', '20:6D:31:01:2B:88', 'intf', '88888888-4881-4881-4881-488148812888', 'lastActiveTimestamp', currentTs);
      await rclient.hsetAsync('policy:mac:20:6D:31:01:2B:88', 'tags', '["88"]', 'monitor', false);
      await rclient.hsetAsync('host:mac:20:6D:31:01:2B:89', 'mac', '20:6D:31:01:2B:89', 'intf', '99999999-4881-4881-4881-488148812999', 'lastActiveTimestamp', currentTs);
      await rclient.hsetAsync('policy:mac:20:6D:31:01:2B:89', 'monitor', false);
      this.hm.hostsdb['host:mac:20:6D:31:01:2B:88'] = new Host({mac: '20:6D:31:01:2B:88', ipv4Addr: '10.88.1.8', intf:'88888888-4881-4881-4881-488148812888', lastActiveTimestamp: currentTs}, true);
      this.hm.hostsdb['host:mac:20:6D:31:01:2B:88'].policy = {tags:["88"],monitor: false};
      this.hm.hostsdb['host:mac:20:6D:31:01:2B:89'] = new Host({mac: '20:6D:31:01:2B:89', ipv4Addr: '10.88.1.9', intf:'99999999-4881-4881-4881-488148812999', lastActiveTimestamp: currentTs}, true);
      this.hm.hostsdb['host:mac:20:6D:31:01:2B:89'].policy = {monitor: false};
      this.hm.hosts.all.push(this.hm.hostsdb['host:mac:20:6D:31:01:2B:88']);
      this.hm.hosts.all.push(this.hm.hostsdb['host:mac:20:6D:31:01:2B:89']);
      done();
    })();
  });

  afterEach((done) => {
    (async() => {
      await rclient.delAsync('host:mac:20:6D:31:01:2B:88');
      await rclient.delAsync('host:mac:20:6D:31:01:2B:89');
      await rclient.hdelAsync('policy:system', 'weak_password_scan');
      done();
    })();
  });

  it('should get scan hosts', async() => {
    let data;
    await _setTargetPolicy('network', '99999999-4881-4881-4881-488148812999', null);
    await _setTargetPolicy('tag', 88, null);
    await _setTargetPolicy('host', '20:6D:31:01:2B:88', null);
    await _setTargetPolicy('host', '20:6D:31:01:2B:89', null);

    // network state true
    await _setTargetPolicy('network', '88888888-4881-4881-4881-488148812888', true);

    data = await this.plugin.getScanHosts({defaultOn: false, ts:9999});
    expect(data.hosts).to.be.eql(['20:6D:31:01:2B:88']);

    data = await this.plugin.getScanHosts({defaultOn: true, ts:9999});
    expect(data.hosts).to.be.eql(['20:6D:31:01:2B:88','20:6D:31:01:2B:89']);

    // tag state false
    await _setTargetPolicy('tag', 88, false);
    data = await this.plugin.getScanHosts({defaultOn: false, ts:9999});
    expect(data.hosts.length).to.be.equal(0);

    data = await this.plugin.getScanHosts({defaultOn: true, ts:9999});
    expect(data.hosts).to.be.eql(['20:6D:31:01:2B:89']);

    // device state true
    await _setTargetPolicy('host', '20:6D:31:01:2B:88', true);
    data = await this.plugin.getScanHosts({defaultOn: false, ts:9999});
    expect(data.hosts).to.be.eql(['20:6D:31:01:2B:88']);

    data = await this.plugin.getScanHosts({defaultOn: true, ts:9999});
    expect(data.hosts).to.be.eql(['20:6D:31:01:2B:88','20:6D:31:01:2B:89']);

    // device state true, default off
    await _setTargetPolicy('host', '20:6D:31:01:2B:89', true);
    data = await this.plugin.getScanHosts({defaultOn: false, ts:9999});
    expect(data.hosts).to.be.eql(['20:6D:31:01:2B:88','20:6D:31:01:2B:89']);

    // device state false, default on
    await _setTargetPolicy('host', '20:6D:31:01:2B:89', false );
    data = await this.plugin.getScanHosts({defaultOn: true, ts:9999});
    expect(data.hosts).to.be.eql(['20:6D:31:01:2B:88']);
  });

  it('should apply policy', async() => {
    const now = Date.now() / 1000;
    await this.plugin.applyPolicy(this.hm, '0.0.0.0', {});
    await this.plugin.applyPolicy(this.hm, '0.0.0.0', {cron: '1 * * * *', ts:now});

    await this.plugin.applyPolicy(this.hm, '0.0.0.0', {state: true, defaultOn: true, cron: '1 2 * * *', ts:now});

    cronPolicy.ts = now;
    await this.plugin.applyPolicy(this.hm, '0.0.0.0', cronPolicy);
  });

  it('should prepare run', async() => {
    let p = null;
    await rclient.hdelAsync('policy:system', 'weak_password_scan');
    p = await this.plugin.loadPolicyAsync();
    expect(p).to.be.undefined;

    await rclient.hsetAsync('policy:system', 'weak_password_scan', '{"state": true, "cron": "1 1 * * *"}');
    p = await this.plugin.loadPolicyAsync();
    expect(p.cron).to.be.equal('1 1 * * *');
  });
});
