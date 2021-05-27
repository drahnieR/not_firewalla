/*    Copyright 2016 - 2021 Firewalla Inc 
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

const log = require('../../net2/logger.js')(__filename);
const fs = require('fs');
const util = require('util');
const f = require('../../net2/Firewalla.js');

const Message = require('../../net2/Message.js');
const VPNClient = require('./VPNClient.js');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;

const SERVICE_NAME = "openvpn_client";

class OpenVPNClient extends VPNClient {
  _getRedisRouteUpMessageChannel() {
    return Message.MSG_OVPN_CLIENT_ROUTE_UP;
  }

  async setup() {
    await super.setup();
    const profileId = this.profileId;
    if (!profileId)
      throw "profileId is not set";
    const ovpnPath = this.getProfilePath();
    if (await fs.accessAsync(ovpnPath, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      this.ovpnPath = ovpnPath;
      await this._reviseProfile(this.ovpnPath);
    } else throw util.format("ovpn file %s is not found", ovpnPath);
  }

  getProfilePath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".ovpn";
    return path;
  }

  getPasswordPath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".password";
    return path;
  }

  getUserPassPath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".userpass";
    return path;
  }

  _getSettingsPath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".settings";
    return path;
  }

  _getPushOptionsPath() {
    return `${f.getHiddenFolder()}/run/ovpn_profile/${this.profileId}.push_options`;
  }

  _getGatewayFilePath() {
    return `${f.getHiddenFolder()}/run/ovpn_profile/${this.profileId}.gateway`;
  }

  _getSubnetFilePath() {
    return `${f.getHiddenFolder()}/run/ovpn_profile/${this.profileId}.subnet`;
  }

  _getStatusLogPath() {
    return `/var/log/openvpn_client-status-${this.profileId}.log`;
  }

  async _cleanupLogFiles() {
    await exec(`sudo rm /var/log/openvpn_client-status-${this.profileId}.log*`).catch((err) => {});
    await exec(`sudo rm /var/log/openvpn_client-${this.profileId}.log*`).catch((err) => {});
  }

  async _parseProfile(ovpnPath) {
    if (await fs.accessAsync(ovpnPath, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      const content = await fs.readFileAsync(ovpnPath, {encoding: 'utf8'});
      const lines = content.split("\n");
      this._intfType = "tun";
      for (let line of lines) {
        const options = line.split(/\s+/);
        const option = options[0];
        switch (option) {
          case "dev":
          case "dev-type":
            const value = options[1];
            if (value.startsWith("tun"))
              this._intfType = "tun";
            if (value.startsWith("tap"))
              this._intfType = "tap";
            break;
          default:
        }
      }
    } else {
      throw util.format("ovpn file %s is not found", ovpnPath);
    }
  }

  async _reviseProfile(ovpnPath) {
    const cmd = "openvpn --version | head -n 1 | awk '{print $2}'";
    const result = await exec(cmd);
    const version = result.stdout;
    let content = await fs.readFileAsync(ovpnPath, {encoding: 'utf8'});
    let revisedContent = content;
    let revised = false;
    const intf = this.getInterfaceName();
    await this._parseProfile(ovpnPath);
    // used customized interface name
    if (!revisedContent.includes(`dev ${intf}`)) {
      revisedContent = revisedContent.replace(/^dev\s+.*$/gm, `dev ${intf}`);
      revised = true;
    }
    // specify interface type with 'dev-type'
    if (this._intfType === "tun") {
      if (!revisedContent.match(/^dev-type\s+tun\s*/gm)) {
        revisedContent = "dev-type tun\n" + revisedContent;
        revised = true;
      }
    } else {
      if (!revisedContent.match(/^dev-type\s+tap\s*/gm)) {
        revisedContent = "dev-type tap\n" + revisedContent;
        revised = true;
      }
    }
    // add private key password file to profile if present
    if (await fs.accessAsync(this.getPasswordPath(), fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      if (!revisedContent.includes(`askpass ${this.getPasswordPath()}`)) {
        if (!revisedContent.match(/^askpass.*$/gm)) {
          revisedContent = `askpass ${this.getPasswordPath()}\n${revisedContent}`;
        } else {
          revisedContent = revisedContent.replace(/^askpass.*$/gm, `askpass ${this.getPasswordPath()}`);
        }
        revised = true;
      }
    }
    // add user/pass file to profile if present
    if (await fs.accessAsync(this.getUserPassPath(), fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      if (!revisedContent.includes(`auth-user-pass ${this.getUserPassPath()}`)) {
        if (!revisedContent.match(/^auth-user-pass.*$/gm)) {
          revisedContent = `auth-user-pass ${this.getUserPassPath()}\n${revisedContent}`;
        } else {
          revisedContent = revisedContent.replace(/^auth-user-pass.*$/gm, `auth-user-pass ${this.getUserPassPath()}`);
        }
        revised = true;
      }
    }

    if (version.startsWith("2.3.")) {
      const lines = content.split("\n");
      lines.forEach((line) => {
        const options = line.split(/\s+/);
        const option = options[0];
        switch (option) {
          case "compress":
            // OpenVPN 2.3.x does not support 'compress' option
            if (options.length > 1) {
              const algorithm = options[1];
              if (algorithm !== "lzo") {
                throw util.format("Unsupported compress algorithm for OpenVPN 2.3: %s", algorithm);
              } else {
                revisedContent = revisedContent.replace(/compress\s+lzo/g, "comp-lzo");
                revised = true;
              }
            } else {
              // turn off compression, set 'comp-lzo' to no
              revisedContent = revisedContent.replace(/compress/g, "comp-lzo no");
              revised = true;
            }
            break;
          default:
        }
      })
    }
    /* comp-lzo is still compatible in 2.4.x. Need to check the value of comp-lzo for proper convertion, e.g. comp-lzo (yes)-> compress lzo, comp-lzo no -> compress ...
    if (version.startsWith("2.4.")) {
      // 'comp-lzo' is deprecated in 2.4.x
      revisedContent = revisedContent.replace(/comp\-lzo/g, "compress lzo");
    }
    */
    if (revised)
      await fs.writeFileAsync(ovpnPath, revisedContent, {encoding: 'utf8'});
  }

  async _getDNSServers() {
    const pushOptionsFile = this._getPushOptionsPath();
    const dnsServers = [];
    if (await fs.accessAsync(pushOptionsFile, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      const content = await fs.readFileAsync(pushOptionsFile, {encoding: "utf8"});
      if (!content)
        return;
      // parse pushed DNS servers
      for (let line of content.split("\n")) {
        if (line && line.length != 0) {
          log.info(`Parsing push options from ${this.profileId}: ${line}`);
          const options = line.split(/\s+/);
          switch (options[0]) {
            case "dhcp-option":
              if (options[1] === "DNS") {
                dnsServers.push(options[2]);
              }
              break;
            default:
          }
        }
      }
    }
    return dnsServers;
  }

  async _start() {
    let cmd = util.format("sudo systemctl start \"%s@%s\"", SERVICE_NAME, this.profileId);
    await exec(cmd);
  }

  async _stop() {
    let cmd = util.format("sudo systemctl stop \"%s@%s\"", SERVICE_NAME, this.profileId);
    await exec(cmd).catch((err) => {
      log.error(`Failed to stop openvpn client ${this.profileId}`, err.message);
    });
    cmd = util.format("sudo systemctl disable \"%s@%s\"", SERVICE_NAME, this.profileId);
    await exec(cmd).catch((err) => {});
  }

  async status() {
    const cmd = util.format("systemctl is-active \"%s@%s\"", SERVICE_NAME, this.profileId);
    try {
      await exec(cmd);
      return true;
    } catch (err) {
      return false;
    }
  }

  async getStatistics() {
    const status = await this.status();
    if (!status) {
      return {};
    }
    try {
      const stats = {};
      const statusLogPath = this._getStatusLogPath();
      // add read permission in case it is owned by root
      const cmd = util.format("sudo chmod +r %s", statusLogPath);
      await exec(cmd);
      if (!await fs.accessAsync(statusLogPath, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
        log.warn(`status log for ${this.profileId} does not exist`);
        return {};
      }
      const content = await fs.readFileAsync(statusLogPath, {encoding: "utf8"});
      const lines = content.split("\n");
      for (let line of lines) {
        const options = line.split(",");
        const key = options[0];
        switch (key) {
          case "TUN/TAP read bytes":
            // this corresponds to number of original bytes sent to vpn channel. NOT a typo! Read actually corresponds to bytes sent
            stats['bytesOut'] = Number(options[1]);
            break;
          case "TUN/TAP write bytes":
            // this corresponds to number of original bytes received from vpn channel. NOT a type! Write actually corresponds to bytes read
            stats['bytesIn'] = Number(options[1]);
            break;
          case "TCP/UDP read bytes":
            // this corresponds to number of bytes received from VPN server through underlying transport layer
            stats['transportBytesIn'] = Number(options[1]);
            break;
          case "TCP/UDP write bytes":
            // this corresponds to number of bytes sent to VPN server through underlying transport layer
            stats['transportBytesOut'] = Number(options[1]);
            break;
          default:

        }
      }
      return stats;
    } catch (err) {
      log.error("Failed to parse OpenVPN client status file for " + this.profileId, err);
      return {};
    }
  }

  async _getVPNSubnet() {
    const intf = this.getInterfaceName();
    const cmd = util.format(`ip link show dev ${intf}`);
    const subnet = await exec(cmd).then(() => {
      const subnetFile = this._getSubnetFilePath();
      return fs.readFileAsync(subnetFile, "utf8").then((content) => content.trim());
    }).catch((err) =>{
      return null;
    });
    return subnet;
  }

  async _isLinkUp() {
    const remoteIP = await this._getRemoteIP();
    if (remoteIP)
      return true;
    else
      return false;
  }

  async _getRemoteIP() {
    const intf = this.getInterfaceName();
    const cmd = util.format(`ip link show dev ${intf}`);
    const ip = await exec(cmd).then(() => {
      const gatewayFile = this._getGatewayFilePath();
      return fs.readFileAsync(gatewayFile, "utf8").then((content) => content.trim());
    }).catch((err) =>{
      return null;
    });
    return ip;
  }

  async destroy() {
    await super.destroy();
    const filesToDelete = [this.getProfilePath(), this.getUserPassPath(), this.getPasswordPath(), this._getGatewayFilePath(), this._getPushOptionsPath(), this._getSubnetFilePath(), this._getSettingsPath()];
    for (const file of filesToDelete)
      await fs.unlinkAsync(file).catch((err) => {});
    await this._cleanupLogFiles();
  }
}

module.exports = OpenVPNClient;
