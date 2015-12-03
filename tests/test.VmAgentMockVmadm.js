/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var data = require('./data');
var diff = require('deep-diff').diff;
var mockery = require('mockery');
var mocks = require('./mocks');
var test = require('tape');
var node_uuid = require('node-uuid');


// GLOBAL
var coordinator = mocks.coordinator;
var VmAgent;


/*
 * Create a VmAgent with VMAPI, vmadm and VmWatcher mocked out using
 * mocks from ./mocks.js.
 */
mockery.enable({useCleanCache: true, warnOnUnregistered: false});
mockery.registerMock('vmadm', mocks.Vmadm);
mockery.registerMock('./vm-watcher', mocks.VmWatcher);
mockery.registerMock('./vmapi-client', mocks.Vmapi);
VmAgent = require('../lib/vm-agent');
mockery.disable();


function createVm(template, properties) {
    var prop;
    var re = new RegExp(template.uuid, 'g');
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

function newConfig() {
    var config = {
        log: mocks.Logger,
        server_uuid: node_uuid.v4(),
        url: 'http://127.0.0.1/'
    };

    return (config);
}

function resetGlobalState(vmAgent) {
    if (vmAgent) {
        vmAgent.stop();
    }
    mocks.resetState();
}


/*
 * Validate that when VmAgent starts up and vmadm lookup returns a VM that
 * "GET /vms?state=active&server_uuid=..." did not, that this missing VM is
 * included in the "PUT /vms" as part of initialization.
 */
test('Startup VmAgent with VM missing from VMAPI', function (t) {
    var config = newConfig();
    var vmAgent;

    coordinator.on('vmapi.updateServerVms',
        function (vmobjs /* , server_uuid */) {
            var vmadmVms = mocks.Vmadm.peekVms();

            t.equal(Object.keys(vmobjs.vms).length, 1,
                'updateServerVms payload has 1 VM');
            t.notOk(diff(vmobjs.vms[vmadmVms[0].uuid], vmadmVms[0]),
                '"PUT /vms" includes missing VM');

            resetGlobalState(vmAgent);
            t.end();
        }
    );

    mocks.Vmadm.addVm(createVm(data.smartosPayloads[0]));

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();
});

/*
 * Validate that when VmAgent starts up and vmadm lookup is missing a VM that
 * "GET /vms?state=active&server_uuid=..." included, that this missing VM is
 * included in the "PUT /vms" as part of initialization and 'has' state and
 * 'zone_state' set to 'destroyed'.
 */
test('Startup VmAgent with VM missing from vmadm', function (t) {
    var config = newConfig();
    var vmAgent;

    coordinator.on('vmapi.updateServerVms',
        function (vmobjs /* , server_uuid */) {
            var expected;
            var vmapiVms = mocks.Vmapi.peekVms();

            expected = vmapiVms[0];
            expected.state = 'destroyed';
            expected.zone_state = 'destroyed';

            t.equal(Object.keys(vmobjs.vms).length, 1,
                'updateServerVms payload has 1 VM');
            // diff returns undefined on no difference
            t.notEqual(diff(vmobjs.vms[expected.uuid], expected),
                '"PUT /vms" trying to destroy VM');

            resetGlobalState(vmAgent);
            t.end();
        }
    );

    mocks.Vmapi.addVm(createVm(data.smartosPayloads[0]));

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
    var config = newConfig();
    var done = false;
    var mode = 'creating';
    // These are processed from top to bottom. We should have <create_vms>
    // number of VMs on which to operate.
    //
    // TODO: test more modifications
    //
    var mods = [
        {vm: 0, change: 'set', field: 'quota', value: 1000},
        {vm: 1, change: 'set', field: 'cpu_cap', value: 800},
        {vm: 1, change: 'del', field: 'cpu_cap'},
        {vm: 0, change: 'set', field: 'customer_metadata',
            value: {hello: 'world'}}
    ];
    var vmAgent;

    function _addVm() {
        var newVm = createVm(data.smartosPayloads[0]);

        mocks.Vmadm.addVm(newVm);
        t.ok(newVm, 'created VM ' + (newVm ? newVm.uuid : 'undefined'));
        vmAgent.watcher.emit('VmCreated', newVm.uuid);
    }

    function _modVm() {
        var mod = mods[0];
        var vmadmVms = mocks.Vmadm.peekVms();

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
        var vmadmVms = mocks.Vmadm.peekVms();
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
        var vmadmVms = mocks.Vmadm.peekVms();

        if (mode === 'creating') {
            t.equal(vmobj.uuid, vmadmVms[vmadmVms.length - 1].uuid,
                'received PUT /vms/' + vmobj.uuid + ' (' + created + ')');
            created++;

            if (created < create_vms) {
                _addVm();
                return;
            }

            // 3. We've created create_vms VMs, now perform modifications
            mode = 'modifying';
            _modVm();
            return;
        }

        if (mode === 'modifying') {
            mod = mods[0];

            t.equal(vmobj.uuid, vmadmVms[mod.vm].uuid,
                'received PUT /vms/' + vmobj.uuid);
            if (mod.change === 'set') {
                t.equal(vmobj[mod.field], mod.value, 'saw expected modification'
                    + ': ' + mod.field + '=' + JSON.stringify(mod.value));
            } else if (mod.change === 'del') {
                t.notOk(vmobj.hasOwnProperty(mod.field), 'expected field to be '
                    + 'removed: ' + mod.field);
            }

            mods.shift(); // consume this mod

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

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();

    // This just prevents the test from being ended early
    function _waitDone() {
        if (done) {
            resetGlobalState(vmAgent);
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
    var config = newConfig();
    var done = false;
    var prevDelta = 0;
    var prevTimestamp = 0;
    var vmAgent;
    var vmapiGetErr;

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
            mocks.Vmapi.setGetError(null);
        }
    });

    coordinator.on('vmapi.updateServerVms', function (vmobjs, server_uuid) {
        var vmadmVms = mocks.Vmadm.peekVms();

        t.ok(attempts > 5, 'attempts (' + attempts + ') should be > 5 when '
            + 'we see vmapi.updateServerVms()');
        t.equal(Object.keys(vmobjs.vms).length, 1, 'updateServerVms payload has 1 VM');
        // diff returns undefined on no difference
        t.notOk(diff(vmobjs.vms[vmadmVms[0].uuid], vmadmVms[0]),
           '"PUT /vms" includes missing VM');

        done = true;
    });

    mocks.Vmadm.addVm(createVm(data.smartosPayloads[0]));

    // simulate connection refused
    vmapiGetErr = new Error('Connection Refused');
    vmapiGetErr.code = 'ECONNREFUSED';
    vmapiGetErr.errno = 'ECONNREFUSED';
    vmapiGetErr.syscall = 'connect';
    mocks.Vmapi.setGetError(vmapiGetErr);

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();

    // This just prevents the test from being ended early
    function _waitDone() {
        if (done) {
            resetGlobalState(vmAgent);
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
    var config = newConfig();
    var done = false;
    var modifications = 0;
    var prevDelta = 0;
    var prevTimestamp = 0;
    var vmAgent;

    function _modVm(modFn) {
        var vmadmVms = mocks.Vmadm.peekVms();

        modFn(vmadmVms[0]);
        // after caller modifies VM, notify VmWatcher
        vmAgent.watcher.emit('VmModified', vmadmVms[0].uuid);
        modifications++;
    }

    coordinator.on('vmapi.updateVm', function (vmobj, err) {
        var delta;
        var vmadmVms = mocks.Vmadm.peekVms();
        var vmapiPutErr;

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
            mocks.Vmapi.setPutError(vmapiPutErr);
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
            if (mocks.Vmapi.getPutError()) {
                // at 5 attempts, the problem is "resolved"
                mocks.Vmapi.setPutError(null);
                return;
            }
            t.equal(attempts, 9, 'saw actual update on only attempt 9');
            // diff returns undefined on no difference
            t.notOk(diff(vmadmVms[0], vmobj),
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
        var vmadmVms = mocks.Vmadm.peekVms();

        t.equal(Object.keys(vmobjs.vms).length, 1, 'updateServerVms payload has 1 VM');
        // diff returns undefined on no difference
        t.equal(diff(vmobjs.vms[vmadmVms[0].uuid], vmadmVms[0]),
           '"PUT /vms" includes initial VM');

        // wait 11s (should be past 2 of the 5 second polling windows) and then
        // make our first modification to the VM.
        setTimeout(function () {
            _modVm(function (vm) {
                vm.last_modified = (new Date()).toISOString();
            });
        }, 11000);
    });

    mocks.Vmadm.addVm(createVm(data.smartosPayloads[0]));

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();

    // This just prevents the test from being ended early
    function _waitDone() {
        if (done) {
            resetGlobalState(vmAgent);
            t.end();
            return;
        }
        setTimeout(_waitDone, 100);
    }

    _waitDone();
});

/*
 * VmAgent starts, there's a single VM in vmadm that gets updated to VMAPI.
 * After VMAPI is updated, it crashes and starts returning ECONNREFUSED, the VM
 * is deleted from vmadm while in this state. When VMAPI "recovers", we should
 * correctly mark the VM as destroyed.
 *
 * The purpose here is to ensure that we're keeping the last seen value for the
 * VM object so that we can send a correct VMAPI update.
 */
test('VmAgent sends deletion events after PUT failures', function (t) {
    var attempts = 0;
    var config = newConfig();
    var deletedVmUpdate;
    var done = false;
    var vmAgent;

    // 2. After we've deleted the VM, we should see multiple attempts to PUT the
    //    VM with the state/zone_state 'destroyed'. When we have seen 3 of
    //    these, we'll un-error VMAPI and expect exactly 1 more.
    coordinator.on('vmapi.updateVm', function (vmobj, err) {
        attempts++;
        // diff returns undefined on no difference
        t.notOk(diff(deletedVmUpdate, vmobj), 'PUT includes VM with '
            + 'only change [zone_]state=destroyed (' + attempts + ')'
            + (err ? ' -- ' + err.name : ''));

        if (attempts === 3) {
            // at 3 attempts, the problem is "resolved"
            mocks.Vmapi.setPutError(null);
        } else if (attempts === 4) {
            // should be the last one!
            setTimeout(function () {
                t.equal(attempts, 4, 'expected 4 total attempts');
                done = true;
            }, 10000);
        } else if (attempts > 4) {
            // uh-oh!
            t.fail('should not have seen put ' + attempts + ' for deleted VM');
        }
    });

    // 1. When we see the initial update, we'll mark VMAPI as broken and delete
    //    the VM from vmadm.
    coordinator.on('vmapi.updateServerVms',
        function _updateServerVms(vmobjs /* , server_uuid */) {
            var deletedVm;
            var vmadmVms = mocks.Vmadm.peekVms();
            var vmapiPutErr;

            t.equal(Object.keys(vmobjs.vms).length, 1,
                'updateServerVms payload has 1 VM');
            // diff returns undefined on no difference
            t.notOk(diff(vmobjs.vms[vmadmVms[0].uuid], vmadmVms[0]),
               '"PUT /vms" includes missing VM');

            // simulate Moray down
            vmapiPutErr = new Error('{"message":"no active connections"}');
            vmapiPutErr.body = {message: 'no active connections'};
            vmapiPutErr.name = 'InternalServerError';
            mocks.Vmapi.setPutError(vmapiPutErr);

            // now delete the VM.
            deletedVm = vmadmVms.pop();
            t.ok(true, 'deleted VM ' + deletedVm.uuid);
            vmAgent.watcher.emit('VmDeleted', deletedVm.uuid);

            deletedVmUpdate = JSON.parse(JSON.stringify(deletedVm));
            deletedVmUpdate.state = 'destroyed';
            deletedVmUpdate.zone_state = 'destroyed';
        }
    );

    mocks.Vmadm.addVm(createVm(data.smartosPayloads[0]));

    t.ok(config.server_uuid, 'new CN ' + config.server_uuid);
    vmAgent = new VmAgent(config);
    vmAgent.start();

    // This just prevents the test from being ended early
    function _waitDone() {
        if (done) {
            resetGlobalState(vmAgent);
            t.end();
            return;
        }
        setTimeout(_waitDone, 100);
    }

    _waitDone();
});

// TODO: test with 2000 VMs in vmadm, all retrying because VMAPI's busted
