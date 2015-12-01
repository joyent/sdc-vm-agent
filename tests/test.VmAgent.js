/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var diff = require('deep-diff').diff;
var EventEmitter = require('events').EventEmitter;
var test = require('tape');
var util = require('util');
var node_uuid = require('node-uuid');
var VmAgent = require('../lib/vm-agent');

var logStub = {
    child: function () { return logStub; },
    trace: function () { return true; },
    debug: function () { return true; },
    info:  function () { return true; },
    warn:  function () { return true; },
    error: function (err) { console.log(err); return true; }
};

// GLOBAL
var fakeWatcher;
var vmAgent;
var vmadmErr;
var vmadmVms = [];
var vmapiGetErr;
var vmapiPutErr;
var vmapiVms = [];

var standardVm = {
    "zonename": "6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c",
    "autoboot": true,
    "brand": "joyent-minimal",
    "limit_priv": "default",
    "v": 1,
    "create_timestamp": "2015-11-27T05:01:25.838Z",
    "image_uuid": "cd2d08a0-83f1-11e5-8684-f383641a9854",
    "cpu_shares": 128,
    "max_lwps": 1000,
    "max_msg_ids": 4096,
    "max_sem_ids": 4096,
    "max_shm_ids": 4096,
    "max_shm_memory": 128,
    "zfs_io_priority": 10,
    "max_physical_memory": 128,
    "max_locked_memory": 128,
    "max_swap": 256,
    "cpu_cap": 100,
    "billing_id": "73a1ca34-1e30-48c7-8681-70314a9c67d3",
    "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
    "package_name": "sdc_128",
    "package_version": "1.0.0",
    "tmpfs": 128,
    "dns_domain": "local",
    "archive_on_delete": true,
    "maintain_resolvers": true,
    "resolvers": [
      "10.192.0.11"
    ],
    "alias": "testvm",
    "nics": [
      {
        "interface": "net0",
        "mac": "92:88:1a:79:75:71",
        "vlan_id": 0,
        "nic_tag": "admin",
        "netmask": "255.192.0.0",
        "ip": "10.192.0.8",
        "ips": [
          "10.192.0.8/10"
        ],
        "primary": true
      }
    ],
    "uuid": "6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c",
    "zone_state": "running",
    "zonepath": "/zones/6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c",
    "zoneid": 9,
    "last_modified": "2015-11-27T06:19:37.000Z",
    "firewall_enabled": false,
    "server_uuid": "564dfd57-1dd4-6fc0-d973-4f137ee12afe",
    "datacenter_name": "coal",
    "platform_buildstamp": "20151126T011339Z",
    "state": "running",
    "boot_timestamp": "2015-11-28T07:56:44.000Z",
    "pid": 5200,
    "customer_metadata": {},
    "internal_metadata": {},
    "routes": {},
    "tags": {},
    "quota": 25,
    "zfs_root_recsize": 131072,
    "zfs_filesystem": "zones/6d7d6f4b-4553-49f1-bc0b-7fd16dcf0f2c",
    "zpool": "zones",
    "snapshots": []
};


/*
 * This coordinator is an event emitter that we use from within the mocks to
 * tell us when those functions have occurred. Tests can watch for events which
 * indicate the calling of each function. and the event will include the
 * relevant function parameters.
 */
function Coordinator(opts) {
    // Initialize necessary properties from `EventEmitter` in this instance
    EventEmitter.call(this);
}
util.inherits(Coordinator, EventEmitter);

var coordinator = new Coordinator();

// Fake vmadm for testing

var fakeVmadm = {
    lookup: function (search, opts, callback) {
        process.nextTick(function _delayedLookupEmit() {
            coordinator.emit('vmadm.lookup', search, opts);
        });
        if (vmadmErr) {
            callback(vmadmErr);
            return;
        }
        callback(null, vmadmVms);
    }, load: function (opts, callback) {
        var err;
        var vmobj;
        var vmobjIdx;

        process.nextTick(function _delayedLoadEmit() {
            coordinator.emit('vmadm.load', opts);
        });
        for (vmobjIdx in vmadmVms) {
            if (vmadmVms[vmobjIdx].uuid === opts.uuid) {
                vmobj = vmadmVms[vmobjIdx];
            }
        }
        if (!vmobj) {
            err = new Error('vmadm lookup ' + opts.uuid
                + ' failed: No such zone');
            err.restCode = 'VmNotFound';
            err.stderr = 'look at me, I am a fake vmadm';
            callback(err);
        } else if (vmadmErr) {
            callback(vmadmErr);
        } else {
            callback(null, vmobj);
        }
    }
};

// Fake VMAPI for testing

var fakeVmapi = function (options) {
    //console.log('userAgent: ' + options.userAgent);
};

fakeVmapi.prototype.getVms = function (server_uuid, callback) {
    process.nextTick(function _delayedGetEmit() {
        coordinator.emit('vmapi.getVms', server_uuid);
    });
    if (vmapiGetErr) {
        callback(vmapiGetErr);
        return;
    }
    callback(null, vmapiVms);
};

fakeVmapi.prototype.updateServerVms = function (server_uuid, vmobjs, callback) {
    process.nextTick(function _delayedUpdateVmsEmit() {
        coordinator.emit('vmapi.updateServerVms', vmobjs, server_uuid);
    });
    if (vmapiPutErr) {
        callback(vmapiPutErr);
        return;
    }
    callback();
};

fakeVmapi.prototype.updateVm = function (vmobj, callback) {
    process.nextTick(function _delayedUpdateVmEmit() {
        coordinator.emit('vmapi.updateVm', vmobj,
            (vmapiPutErr ? vmapiPutErr : undefined));
    });
    if (vmapiPutErr) {
        callback(vmapiPutErr);
        return;
    }
    callback();
};

// Fake VmWatcher for testing

function fakeVmWatcher(opts) {
    fakeWatcher = this;
    // Initialize necessary properties from `EventEmitter` in this instance
    EventEmitter.call(this);
}
util.inherits(fakeVmWatcher, EventEmitter);

fakeVmWatcher.prototype.start = function () {
    //console.error('vmwatcher.start');
};
fakeVmWatcher.prototype.stop = function () {
    //console.error('vmwatcher.start');
};
fakeVmWatcher.prototype.doEmit = function (action, vm_uuid) {
    var self = this;
    self.emit(action, vm_uuid);
};


function createVm(template, properties) {
    var prop;
    var re = new RegExp(template.uuid, 'g')
    var stringed = JSON.stringify(template);
    var uuid = node_uuid.v4();
    var vmobj = JSON.parse(stringed.replace(re, uuid));

    // generate a random alias by cutting the first chunk from a UUID
    vmobj.alias = node_uuid.v4().split('-')[0];

    if (properties) {
        for (prop in properties) {
            if (properties.hasOwnProperty(prop)) {
                vmobj[prop] = properties[prop];
            }
        }
    }

    return (vmobj);
}

// cleans global variables for the next test.
function recycleGlobals() {
    coordinator.removeAllListeners();
    fakeWatcher = undefined;
    vmAgent = undefined;
    vmadmErr = undefined;
    vmadmVms = [];
    vmapiGetErr = undefined;
    vmapiPutErr = undefined;
    vmapiVms = [];
}

/*
 * Validate that when VmAgent starts up and vmadm lookup returns a VM that
 * "GET /vms?state=active&server_uuid=..." did not, that this missing VM is
 * included in the "PUT /vms" as part of initialization.
 */
test('Startup VmAgent with VM missing from VMAPI', function (t) {
    var config = {
        log: logStub,
        server_uuid: node_uuid.v4(),
        url: 'http://127.0.0.1/',
        vmadm: fakeVmadm,
        vmapi: fakeVmapi,
        vmwatcher: fakeVmWatcher
    };
    var missing_vm;

    coordinator.on('vmapi.updateServerVms', function (vmobjs, server_uuid) {
        t.equal(Object.keys(vmobjs.vms).length, 1, 'updateServerVms payload has 1 VM');
        t.equal(diff(vmobjs.vms[vmadmVms[0].uuid], vmadmVms[0]), undefined,
            '"PUT /vms" includes missing VM');

        recycleGlobals();
        t.end();
    });

    vmapiVms = [];
    vmadmVms = [createVm(standardVm)];

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();
    vmAgent.stop(); // TODO: cleanup
});

/*
 * Validate that when VmAgent starts up and vmadm lookup is missing a VM that
 * "GET /vms?state=active&server_uuid=..." included, that this missing VM is
 * included in the "PUT /vms" as part of initialization and 'has' state and
 * 'zone_state' set to 'destroyed'.
 */
test('Startup VmAgent with VM missing from vmadm', function (t) {
    var config = {
        log: logStub,
        server_uuid: node_uuid.v4(),
        url: 'http://127.0.0.1/',
        vmadm: fakeVmadm,
        vmapi: fakeVmapi,
        vmwatcher: fakeVmWatcher
    };

    coordinator.on('vmapi.updateServerVms', function (vmobjs, server_uuid) {
        var expected = vmapiVms[0];
        expected.state = 'destroyed';
        expected.zone_state = 'destroyed';

        t.equal(Object.keys(vmobjs.vms).length, 1, 'updateServerVms payload has 1 VM');
        t.equal(diff(vmobjs.vms[expected.uuid], expected), undefined,
            '"PUT /vms" trying to destroy VM');

        recycleGlobals();
        t.end();
    });

    vmadmVms = [];
    vmapiVms = [createVm(standardVm)];

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();
});

/*
 * Start with vmapi + vmadm empty, then create some VMs. Then perform some
 * modifications on these VMs and delete all of them. Each of these operations
 * should result in a PUT /vms/<uuid> and we'll check that the relevant
 * parameters were updated correctly.
 */
test('VmAgent with vmapi/vmadm initially empty, apply changes', function (t) {
    var created = 0;
    var create_vms = 4;
    var config = {
        log: logStub,
        server_uuid: node_uuid.v4(),
        url: 'http://127.0.0.1/',
        vmadm: fakeVmadm,
        vmapi: fakeVmapi,
        vmwatcher: fakeVmWatcher
    };
    var done = false;
    var mode = 'creating';
    // These are processed from bottom to top. We should have create_vms number
    // of VMs.
    var mods = [
        {vm: 0, change: 'set', field: 'quota', value: 1000},
        {vm: 1, change: 'del', field: 'cpu_cap'},
        {vm: 1, change: 'set', field: 'cpu_cap', value: 800},
        {vm: 0, change: 'set', field: 'customer_metadata', value: {'hello': 'world'}}
    ];

    function _addVm() {
        var newVm = createVm(standardVm);

        vmadmVms.push(newVm);
        t.ok(newVm, 'created VM ' + (newVm ? newVm.uuid : 'undefined'));
        vmAgent.watcher.emit('VmCreated', newVm.uuid);
    }

    function _modVm() {
        var mod = mods[mods.length - 1];

        if (mod.change === 'set') {
            vmadmVms[mod.vm][mod.field] = mod.value;
        } else if (mod.change === 'del') {
            delete vmadmVms[mod.vm][mod.field];
        }
        t.ok(true, 'modified VM ' + mod.field + '='
            + vmadmVms[mod.vm][mod.field]);
        vmAgent.watcher.emit('VmModified', vmadmVms[mod.vm].uuid);
    }

    function _delVm() {
        var vm = vmadmVms.pop();
        t.ok(true, 'deleted VM ' + vm.uuid);
        vmAgent.watcher.emit('VmDeleted', vm.uuid);
    }

    // 1. When VmAgent is doing its initialization, it does a vmadm.lookup for
    // all VMs on the CN, when we see that we add our first VM. That VM will be
    // processed we'll see vmapi.updateVm and move to stage 2.
    coordinator.on('vmadm.lookup', function (search, opts) {
        t.ok(!opts.fields, 'vmadm.lookup should not have "fields"');
        if (!opts.fields) {
            // initial lookup, ready to pretend some changes
            _addVm();
            return;
        }

        // should not see this in this test.
        t.fail('vmadm.lookup called with fields');
    });

    // 2. When a VM is created/modified/deleted this will be called. At first
    // (until we've created enoug VMs) we'll just add a new one each time. Then
    // we'll perform some modifications to make sure those show up as updates.
    coordinator.on('vmapi.updateVm', function (vmobj) {
        var found;
        var mod;

        if (mode === 'creating') {
            t.equal(vmobj.uuid, vmadmVms[vmadmVms.length - 1].uuid,
                'received PUT /vms/' + vmobj.uuid + ' (' + created + ')');
            created++;
            if (created < create_vms) {
                _addVm();
                return;
            } else {
                // 3. We've created create_vms VMs, now perform modifications
                mode = 'modifying';
                _modVm();
                return;
            }
        }

        if (mode === 'modifying') {
            mod = mods[mods.length - 1];

            t.equal(vmobj.uuid, vmadmVms[mod.vm].uuid,
                'received PUT /vms/' + vmobj.uuid);
            if (mod.change === 'set') {
                t.equal(vmobj[mod.field], mod.value, 'saw expected modification'
                    + ': ' + mod.field + '=' + JSON.stringify(mod.value));
            } else if (mod.change === 'del') {
                t.equal(vmobj[mod.field], undefined, 'expected field to be '
                    + 'removed: ' + mod.field);
            }

            mods.pop(); // consume this mod

            if (mods.length > 0) {
                _modVm();
                return;
            } else {
                // 4. We've performed all modifications, delete the VMs
                mode = 'deleting';
                _delVm();
                return;
            }
        }

        if (mode === 'deleting') {
            found = false;
            vmadmVms.forEach(function _findVm(vm) {
                if (vm.uuid === vmobj.uuid) {
                    found = true;
                }
            });
            t.ok(!found, 'received PUT /vms/' + vmobj.uuid + ' should not be in'
                + ' vmadm list');
            t.equal(vmobj.state, 'destroyed', 'state should be destroyed');
            t.equal(vmobj.zone_state, 'destroyed', 'zone_state should be '
                + 'destroyed');

            if (vmadmVms.length > 0) {
                _delVm();
            } else {
                // 5. All VMs are gone, we're finally done!
                t.ok(true, 'All VMs are gone');
                done = true;
            }
        }
    });

    coordinator.on('vmapi.updateServerVms', function (vmobjs, server_uuid) {
        // We shouldn't see this in this test.
        t.fail('vmapi.updateServerVms should not have been called');
    });

    // start w/ empty vmapi + vmadm
    vmadmVms = [];
    vmapiVms = [];

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();

    // This just prevents the test from being ended early
    function _waitDone() {
        if (done) {
            recycleGlobals();
            t.end();
            return;
        }
        setTimeout(_waitDone, 100);
    }

    _waitDone();
});

/*
 * When VmAgent starts, VMAPI is unavailable and there's a VM in vmadm that
 * does not exist in VMAPI. After 5 failed attempts (delta should be growing)
 * the problem should be resolved and the new VM should be PUT.
 */
test('VmAgent retries when VMAPI returning errors', function (t) {
    var attempts = 0;
    var config = {
        log: logStub,
        server_uuid: node_uuid.v4(),
        url: 'http://127.0.0.1/',
        vmadm: fakeVmadm,
        vmapi: fakeVmapi,
        vmwatcher: fakeVmWatcher
    };
    var done = false;
    var prevDelta = 0;
    var prevTimestamp = 0;

    coordinator.on('vmapi.getVms', function (server_uuid) {
        var delta;

        attempts++;
        t.ok(true, 'vmapi.getVms() called (' + attempts + ')');
        if (prevTimestamp > 0) {
            delta = (new Date()).getTime() - prevTimestamp;
            t.ok(delta > prevDelta, 'delta increasing: ' + delta + ' > '
                + prevDelta);
            prevDelta = delta;
        }
        prevTimestamp = (new Date()).getTime();

        if (attempts >= 5) {
            // at 5 attempts, the problem is "resolved"
            vmapiGetErr = undefined;
        }
    });

    coordinator.on('vmapi.updateServerVms', function (vmobjs, server_uuid) {
        // We shouldn't see this in this test.
        t.ok(attempts > 5, 'attempts (' + attempts + ') should be > 5 when '
            + 'we see vmapi.updateServerVms()');
        t.equal(Object.keys(vmobjs.vms).length, 1, 'updateServerVms payload has 1 VM');
        t.equal(diff(vmobjs.vms[vmadmVms[0].uuid], vmadmVms[0]), undefined,
           '"PUT /vms" includes missing VM');

        done = true;
    });

    // start w/ empty vmapi + vmadm
    vmadmVms = [createVm(standardVm)];

    // simulate connection refused
    vmapiGetErr = new Error('Connection Refused');
    vmapiGetErr.code = 'ECONNREFUSED';
    vmapiGetErr.errno = 'ECONNREFUSED';
    vmapiGetErr.syscall = 'connect';

    vmapiVms = [];

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();

    // This just prevents the test from being ended early
    function _waitDone() {
        if (done) {
            recycleGlobals();
            t.end();
            return;
        }
        setTimeout(_waitDone, 100);
    }

    _waitDone();
});

/*
 * VmAgent starts, there's a single VM in vmadm that gets updated to VMAPI.
 * Several modifications are done and while some of these occur VMAPI returns
 * errors. Tests that PUT /vms/<uuid> handles re-queuing the task correctly and
 * that the final VM is PUT when it's back online.
 */
test('VmAgent retries when VMAPI errors on PUT /vms/<uuid>', function (t) {
    var attempts = 0;
    var config = {
        log: logStub,
        server_uuid: node_uuid.v4(),
        url: 'http://127.0.0.1/',
        vmadm: fakeVmadm,
        vmapi: fakeVmapi,
        vmwatcher: fakeVmWatcher
    };
    var done = false;
    var modifications = 0;
    var prevDelta = 0;
    var prevTimestamp = 0;

    function _modVm(modFn) {
        modFn(vmadmVms[0]);
        // after caller modifies VM, notify VmWatcher
        fakeWatcher.doEmit('VmModified', vmadmVms[0].uuid);
        modifications++;
    }

    coordinator.on('vmapi.updateVm', function (vmobj, err) {
        var delta;

        attempts++;

        t.equal(vmobj.uuid, vmadmVms[0].uuid, 'saw PUT /vms/' + vmobj.uuid
            + (err ? ' -- ' + err.code : ''));
        if (modifications === 1) {
            _modVm(function (vm) {
                vm.state = 'stopped';
                vm.zone_state = 'installed';
                t.ok(true, 'modified VM ' + vm.uuid
                    + ' (state,zone_state) = "stopped,installed"');
            });
            return;
        } else if (modifications === 2) {
            // now we'll simulate connection refused
            vmapiPutErr = new Error('Connection Refused');
            vmapiPutErr.code = 'ECONNREFUSED';
            vmapiPutErr.errno = 'ECONNREFUSED';
            vmapiPutErr.syscall = 'connect';
            _modVm(function (vm) {
                vm.state = 'running';
                vm.zone_state = 'running';
                t.ok(true, 'modified VM ' + vm.uuid
                    + ' (state,zone_state) = "running"');
            });
            return;
        } else if (modifications === 3) {
            _modVm(function (vm) {
                vm.max_physical_memory *= 2;
                vm.max_swap *= 2;
                vm.max_locked_memory *= 2;
                t.ok(true, 'modified VM ' + vm.uuid
                    + ' (max_{swap,phys,locked} += 2)');
            });
            return;
        }

        if (prevTimestamp > 0) {
            delta = (new Date()).getTime() - prevTimestamp;
            t.ok(delta > prevDelta, 'delta increasing: ' + delta + ' > '
                + prevDelta);
            prevDelta = delta;
        }
        prevTimestamp = (new Date()).getTime();

        // We've made modifications to vmadmVms[0] while vmapi updates were
        // failing. Once it has failed > 5 times, we'll "fix the glitch" and
        // the next update should include all our changes. We should get exactly
        // 1 more update.

        if (attempts > 7) {
            if (vmapiPutErr) {
                // at 5 attempts, the problem is "resolved"
                vmapiPutErr = undefined;
                return;
            }
            t.equal(attempts, 9, 'saw actual update on only attempt 9');
            t.equal(diff(vmadmVms[0], vmobj), undefined,
                'all VM changes reflected in final PUT');

            // last attempt should have had delay of ~8000ms, so waiting 20k
            // here in case there's another attempt.
            setTimeout(function () {
                t.equal(attempts, 9, 'no more attempts past 9');
                done = true;
            }, 20000);
        }
    });

    coordinator.on('vmapi.updateServerVms', function (vmobjs, server_uuid) {
        t.equal(Object.keys(vmobjs.vms).length, 1, 'updateServerVms payload has 1 VM');
        t.equal(diff(vmobjs.vms[vmadmVms[0].uuid], vmadmVms[0]), undefined,
           '"PUT /vms" includes initial VM');

        // wait 11s (should be past 2 of the 5 second polling windows) and then
        // make our first modification to the VM.
        setTimeout(function () {
            _modVm(function (vm) {
                vm.last_modified = (new Date()).toISOString();
            });
        }, 11000);
    });

    // start w/ empty vmapi + vmadm
    vmadmVms = [createVm(standardVm)];
    vmapiVms = [];

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();

    // This just prevents the test from being ended early
    function _waitDone() {
        if (done) {
            recycleGlobals();
            t.end();
            return;
        }
        setTimeout(_waitDone, 100);
    }

    _waitDone();
});


// Test w/ updates happening after running for a bit, and VMAPI returning errors
// also with modifications ongoing. The VMs should be loaded and PUT when VMAPI
// recovers.

// Test w/ updates happening while init is retrying. Ensure these are queued and
// processed when we finally are up. XXX: do we need to clear on each init loop
// since we're doing a full reload anyway?? Maybe start just before vmadm lookup
// and clear on error?

// Test with no differences between the two and that we don't bother sending an
// update.

// TODO: real vmadm + fake VMAPI:
//      - create a new VM -- should be sent to VMAPI
//      - delete a VM -- shouldbe updated in VMAPI as destroyed
//      - do all the modifications can think of on a VM:
//         - mdata-put/delete
//         - stop/start/reboot
//         - modify quota using zfs
//         - modify properties using vmadm
//         - etc.
//