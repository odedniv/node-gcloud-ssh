'use strict';

const Compute = require('@google-cloud/compute');
const { OsLoginServiceClient } = require('@google-cloud/os-login');
const ssh = require('ssh2');
const net = require('net');
const sshpk = require('sshpk');
const crypto = require('crypto');
const AsyncLock = require('async-lock');

// SSH keys APIs in Google are not thread-safe, attempting to not modify them in parallel (only helps when running in the same process)
const lock = new AsyncLock();

class GcloudSsh {
  constructor({ instance, host, projectId, keyFilename }) {
    this.instance = instance;
    this._host = host;

    this.computeClient = new Compute({ projectId, keyFilename });
    this.osLoginServiceClient = new OsLoginServiceClient({ projectId, keyFilename });

    this.result = {
      end: () => this.end(),
    };
  }

  start() {
    let promise = new Promise(async (resolve, reject) => {
      this.reject = reject; // allowing rejecting while locked if promise ended
      try {
        resolve(await lock.acquire('key', () => this.promise()));
      } catch (err) {
        reject(err);
      }
    });
    Object.assign(promise, this.result);
    return promise;
  }

  end() {
    if (this.client) this.client.end();
    this.ended = true;
    this.reject(new Error('Aborted'));
  }

  async promise() {
    let oldOtherSshFingerprints = await this.getOtherFingerprints();
    while (!this.ended) {
      await this.osLogin();
      try {
        await this.ssh();
      } catch (err) {
        // retrying to process of OS login & SSH in case of a race condition with other processes modifying SSH keys
        if (!err || err.message !== 'All configured authentication methods failed') {
          // didn't fail due to permissions
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // making sure we get an updated list of fingerprints?
        let newOtherSshFingerprints = await this.getOtherFingerprints();
        if (JSON.stringify(newOtherSshFingerprints) === JSON.stringify(oldOtherSshFingerprints)) {
          // there were no changes, no race condition
          throw err;
        }
        oldOtherSshFingerprints = newOtherSshFingerprints;
        continue; // retry
      }
      break;
    }
    if (this.ended && this.client) this.client.end();
    return this.client;
  }

  async osLogin() {
    let response = await this.osLoginServiceClient.importSshPublicKey({
      parent: this.osLoginServiceClient.userPath(await this.user),
      sshPublicKey: {
        key: this.key.toPublic().toString(),
        expirationTimeUsec: ((Date.now() + 10 * 60 * 1000) * 1000).toString(), // 10 minutes
      },
    });
    this.loginProfile = response[0].loginProfile;
  }

  async getOtherFingerprints() {
    let response = await this.osLoginServiceClient.getLoginProfile({ name: this.osLoginServiceClient.userPath(await this.user) });
    return Object.keys(response[0].sshPublicKeys).filter(fingerprint => fingerprint != this.fingerprint);
  }

  ssh() {
    return new Promise(async (resolve, reject) => {
      this.client = new ssh();
      this.client
        .on('ready', resolve)
        .on('error', reject);
      this.client.connect({
        host: await this.host,
        username: this.loginProfile.posixAccounts[0].username,
        privateKey: this.key.toString(),
      });
      this.client._sock.unref();
    });
  }

  get host() {
    if (!this._host) {
      this._host = this.computeClient
        .zone(this.instance.zone)
        .vm(this.instance.name)
        .get()
        .then(response => {
          // find the first public IP
          for (let networkInterface of response[1].networkInterfaces) {
            for (let accessConfig of networkInterface.accessConfigs) {
              if (accessConfig.natIP) return accessConfig.natIP;
            }
          }
        });
    }
    return this._host;
  }

  get user() {
    if (!this._user) {
      this._user = new Promise(async resolve => {
        let credentials = await this.osLoginServiceClient.auth.getCredentials();
        resolve(credentials.client_email);
      });
    }
    return this._user;
  }

  get key() {
    if (!this._key) {
      this._key = sshpk.generatePrivateKey('ecdsa');
    }
    return this._key;
  }

  get fingerprint() {
    if (!this._fingerprint) {
      this._fingerprint = crypto.createHash('sha256')
        .update(this.key.toPublic().toBuffer())
        .digest('hex');
    }
    return this._fingerprint;
  }
}

function gcloudSsh(options) {
  return new GcloudSsh(options).start();
}

module.exports = gcloudSsh;
