# gcloud-ssh

Create secure IAM-controlled SSH connections between Google Cloud resources and VM instances!

This package uses [ssh2](https://www.npmjs.com/package/ssh2) and returns a client on a successful connection.

## How it works with IAM?

Simply give the allowed resource's service account the [`Service Account User`](https://cloud.google.com/compute/docs/access/iam#iam.serviceAccountUser) role,
as well as either [`Compute OS Login`](https://cloud.google.com/compute/docs/access/iam#compute.osLogin)
or (the less recommended) [`Compute OS Admin Login`](https://cloud.google.com/compute/docs/access/iam#compute.osAdminLogin)
(which can be given on a specific VM instance), and start connecting!

## Usage

Install with:

```bash
npm install --save gcloud-ssh
```

Then use it:

```javascript
const gcloudSsh = require('gcloud-ssh');

let clientPromise = gcloudSsh({
  // either instance or host must be supplied
  instance: {
    zone: "gcp-region-with-zone", // e.g. us-east1-d
    name: "instance-name",
  },
  host: "host-or-ip",

  projectId, // optional, project of the instance
  keyFilename: "path/to/service-account-keyfile.json", // optional, path to service account's keyfile
});

// the return value is a promise (that can also be awaited)
clientPromise.then(client => {
  // client is an ssh2 client
});
// ends the ssh2 client if connected, aborts connection attempts otherwise (see Caveat below)
// if connection attempts were aborted the promise will be rejected
clientPromise.end();
```

## Caveat

Google's API for importing SSH keys is not thread-safe (each request updates the keys with all the old keys + 1).
This makes it difficult to ensure that between importing the SSH key and trying to SSH the key will actually be there.

To make this package scalable it uses an in-process lock, and it retries when it identifies someone else is modifying the SSH keys (like a bad locking mechanism).
If you call `.end()` on the returned promise retries will be cancelled.
