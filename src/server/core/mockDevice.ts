import { GLOBAL_CONTEXT } from '../config';
import { Device, Property, Method } from '../interfaces/device';

import { SimulationStore } from '../store/simulationStore';

import { Mqtt as M1, clientFromConnectionString } from 'azure-iot-device-mqtt';
import { Client, ModuleClient } from 'azure-iot-device';
import { Message, SharedAccessSignature } from 'azure-iot-device';
import { ConnectionString, SharedAccessSignature as CommonSaS, } from 'azure-iot-common';

import { Mqtt as Protocol } from 'azure-iot-device-mqtt';

import { Mqtt as MqttDps } from 'azure-iot-provisioning-device-mqtt';
import { SymmetricKeySecurityClient } from 'azure-iot-security-symmetric-key';
import { ProvisioningDeviceClient } from 'azure-iot-provisioning-device';

import { ValueByIdPayload, DesiredPayload } from '../interfaces/payload';
import * as Utils from './utils';
import * as request from 'request';
import * as rw from 'random-words';
import * as Crypto from 'crypto';
import * as _ from 'lodash';
import { PlugIn } from '../interfaces/plugin';
import { Registry } from 'azure-iothub';
import { over } from 'lodash';

export const LOGGING_TAGS = {
    CTRL: {
        HUB: 'HUB',
        DPS: 'DPS',
        DEV: 'DEV',
        DGT: 'DGT',
        EDG: 'EDG',
        MOD: 'MOD',
        LEA: 'LEA'
    },
    DATA: {
        FNC: 'FNC',
        RECV: 'RECV',
        SEND: 'SEND',
        METH: 'METH',
        C2D: 'C2D',
    },
    LOG: {
        OPS: 'PROC',
        EV: {
            ON: 'ON',
            OFF: 'OFF',
            INIT: 'INIT',
            SUCCESS: 'SUCCESS',
            CONNECTED: 'CONNECTED',
            TRYING: 'TRYING',
            ERROR: 'ERROR',
            DELAY: 'DELAY',
            WAITING: 'WAITING'
        },
    },
    MSG: {
        TWIN: 'TWIN',
        MSG: 'MSG'
    },
    SUB: {
        COMP: 'C'
    },
    STAT: {
        MSG: {
            FIRST: 'MSG_FIRST',
            LAST: 'MSG_LAST',
            COUNT: 'MSG_COUNT',
            RATE: 'MSG_RATE'
        },
        TWIN: {
            FIRST: 'TWIN_FIRST',
            LAST: 'TWIN_LAST',
            COUNT: 'TWIN_COUNT',
            RATE: 'TWIN_RATE'
        },
        ON: 'ON',
        OFF: 'OFF',
        CONNECTS: 'CONNECTS',
        COMMANDS: 'COMMANDS',
        C2D: 'C2D',
        DESIRED: 'DESIRED',
        RESTART: 'RESTART',
        ERRORS: 'ERRORS',
        DPS: 'DPS',
        RECONFIGURES: 'RECONFIGURES',
    }
}


interface IoTHubDevice {
    hubName: string;
    client: Client | ModuleClient;
}

interface Timers {
    timeRemain: number,
    originalTime: number
}

interface Stats {
    ON: number,
    OFF: number,
    MSG_FIRST: string
    MSG_LAST: string,
    MSG_COUNT: number,
    MSG_RATE: number,
    TWIN_FIRST: string
    TWIN_LAST: string,
    TWIN_COUNT: number,
    TWIN_RATE: number,
    CONNECTS: number,
    COMMANDS: number,
    C2D: number,
    DESIRED: number,
    RESTART: number,
    ERRORS: number,
    RECONFIGURES: number,
    DPS: number
}

export class MockDevice {

    /// BETA - remote control
    private controlled: boolean = false;
    private previousControlStatus = null;
    private currentControlStatus = LOGGING_TAGS.LOG.EV.OFF;

    private CMD_REBOOT: string;
    private CMD_FIRMWARE: string;
    private CMD_SHUTDOWN: string;

    private FIRMWARE_LOOP: number;
    private CONNECT_POLL: number;
    private RESTART_LOOP: number;

    private LOOP_MINS: any;
    private LOOP_SECS: any;

    private CONNECT_RESTART: boolean = false;
    private useSasMode = true;
    private sasTokenExpiry = 0;

    private simulationStore = new SimulationStore();
    private ranges: any = {};
    private geo: any = {};

    // device is not mutable
    private connectionDPSTimer = null;
    private connectionTimer = null;
    private device: Device = null;
    private iotHubDevice: IoTHubDevice = { client: undefined, hubName: undefined, };

    // keeps track of current iothub name parent edge device is connected to. needed for modules.
    private edgeHubName: string = null;
    private edgeRLTimer = null;
    private edgeRLPayloadAdditions: {};

    private methodRLTimer = null;
    private methodReturnPayload = null;
    private receivedMethodParams = {}
    private twinDesiredPayloadRead = {};

    private twinRLTimer = null;
    private twinRLProps: Array<Property> = [];
    private twinRLPropsPlanValues: Array<Property> = [];
    private twinRLReportedTimers: Array<Timers> = [];
    private twinRLPayloadAdditions: ValueByIdPayload = <ValueByIdPayload>{};
    private twinRLStartUp: Array<string> = [];
    private twinRLStartUpCache: Array<string> = [];

    private msgRLTimer = null;
    private msgRLProps: Array<Property> = [];
    private msgRLPropsPlanValues: Array<Property> = [];
    private msgRLReportedTimers: Array<Timers> = [];
    private msgRLPayloadAdditions: ValueByIdPayload = <ValueByIdPayload>{};
    private msgRLStartUp: Array<string> = [];
    private msgRLStartUpCache: Array<string> = [];

    private desiredMergedCache = {};
    private desiredOverrides: DesiredPayload = <DesiredPayload>{};

    private twinRLMockSensorTimers = {};
    private msgRLMockSensorTimers = {};
    private running: boolean = false;

    private messageService = null;

    private registrationConnectionString: string = null;

    private planModeLastEventTime = 0;

    private dpsRetires: number = 10;

    private delayStartTimer = null;

    private resolversCollection = {
        nameDesiredToId: {},
        idPropToCommIndex: {},
        nameMethodToId: {},
        nameDesiredToIndex: {},
        nameC2dToCommIndex: {},
        nameDmToCommIndex: {}
    }

    private stats: Stats;

    private firstSendMins: string;

    private plugIn: PlugIn = undefined;

    constructor(device: Device, messageService, plugIn: PlugIn) {
        if (device.configuration._kind === 'template') { return; }
        this.messageService = messageService;
        this.plugIn = plugIn;
        this.initialize(device);
    }

    getControlStatus() {
        return this.currentControlStatus;
    }

    getIoTHubHostname() {
        return this.iotHubDevice.hubName;
    }

    getSecondsFromHours(hours: number) {
        var raw = (Date.now() / 1000) + (3600 * hours)
        return Math.ceil(raw);
    }

    // making device any avoids a typing problem
    initialize(device: any) {
        this.ranges = this.simulationStore.get()['ranges'];
        const i = 0;
        let geoIndex = 0;
        if (device.configuration.geo) {
            try { geoIndex = parseInt(device.configuration.geo); } catch { }
        }
        this.geo = this.simulationStore.get()['geo'][geoIndex];
        const commands = this.simulationStore.get()['commands'];
        this.CMD_REBOOT = commands['reboot'];
        this.CMD_FIRMWARE = commands['firmware'];
        this.CMD_SHUTDOWN = commands['shutdown'];

        const simulation = this.simulationStore.get()['simulation'];
        this.FIRMWARE_LOOP = simulation['firmware'];
        this.CONNECT_POLL = simulation['connect'];
        const { min, max } = simulation['restart'];

        const runloop = this.simulationStore.get()['runloop'];
        this.LOOP_MINS = runloop['mins'];
        this.LOOP_SECS = runloop['secs'];

        this.RESTART_LOOP = Utils.getRandomNumberBetweenRange(min, max, true) * 3600000;
        this.sasTokenExpiry = this.getSecondsFromHours(simulation['sasExpire']);

        this.stats = {
            MSG_COUNT: 0,
            MSG_FIRST: null,
            MSG_LAST: null,
            MSG_RATE: 0,
            TWIN_COUNT: 0,
            TWIN_FIRST: null,
            TWIN_LAST: null,
            TWIN_RATE: 0,
            CONNECTS: 0,
            DESIRED: 0,
            ON: 0,
            OFF: 0,
            RESTART: 0,
            RECONFIGURES: -1,
            COMMANDS: 0,
            C2D: 0,
            DPS: 0,
            ERRORS: 0,
        }
        this.updateDevice(device, false);
    }

    // Start of device setup and update code

    updateDevice(device: Device, valueOnlyUpdate: boolean) {
        if (device.configuration._kind === 'template') { return; }
        if (this.device != null && this.device.configuration.connectionString != device.configuration.connectionString) {
            this.log('DEVICE/MODULE UPDATE ERROR. CONNECTION STRING HAS CHANGED. DELETE DEVICE', LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
        } else {
            this.device = Object.assign({}, device);
            if (this.plugIn) { this.plugIn.configureDevice(this.device.configuration.deviceId, this.running); }
            this.reconfigDeviceDynamically(valueOnlyUpdate);
        }
    }

    getRunningStatus() {
        return this.running;
    }

    reconfigDeviceDynamically(valueOnlyUpdate: boolean) {

        if (valueOnlyUpdate) { return; }

        this.log('DEVICE/MODULE HAS BEEN CONFIGURED', LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
        this.logStat(LOGGING_TAGS.STAT.RECONFIGURES);

        this.resolversCollection = {
            idPropToCommIndex: {},
            nameDesiredToId: {},
            nameMethodToId: {},
            nameDesiredToIndex: {},
            nameC2dToCommIndex: {},
            nameDmToCommIndex: {}
        }

        this.twinRLProps = [];
        this.twinRLPropsPlanValues = [];
        this.twinRLReportedTimers = [];
        this.twinRLMockSensorTimers = {};
        this.twinRLStartUp = [];
        this.twinRLStartUpCache = [];

        this.msgRLProps = [];
        this.msgRLPropsPlanValues = [];
        this.msgRLReportedTimers = [];
        this.msgRLMockSensorTimers = {};
        this.msgRLStartUp = [];
        this.msgRLStartUpCache = [];

        this.buildIndexes();

        // for PM we are only interested in the list. the rest has been defined in IM mode
        if (this.device.configuration.planMode) {

            const config = this.simulationStore.get()['plan'];

            this.device.plan.startup.forEach((item) => {
                const comm = this.device.comms[this.resolversCollection.idPropToCommIndex[item.property]];
                if (comm.sdk === 'twin') {
                    this.twinRLProps.push(comm);
                    this.twinRLPropsPlanValues.push(item.value);
                    this.twinRLReportedTimers.push({ timeRemain: config['startDelay'], originalTime: config['startDelay'] });
                } else if (comm.sdk === 'msg') {
                    this.msgRLProps.push(comm);
                    this.msgRLPropsPlanValues.push(item.value);
                    this.msgRLReportedTimers.push({ timeRemain: config['startDelay'], originalTime: config['startDelay'] });
                }
            })

            this.device.plan.timeline.forEach((item) => {
                // find the last event
                this.planModeLastEventTime = (item.time * 1000) + config['timelineDelay'];
                const comm = this.device.comms[this.resolversCollection.idPropToCommIndex[item.property]];
                if (comm.sdk === 'twin') {
                    this.twinRLProps.push(comm);
                    this.twinRLPropsPlanValues.push(item.value);
                    this.twinRLReportedTimers.push({ timeRemain: this.planModeLastEventTime, originalTime: this.planModeLastEventTime });
                } else if (comm.sdk === 'msg') {
                    this.msgRLProps.push(comm);
                    this.msgRLPropsPlanValues.push(item.value);
                    this.msgRLReportedTimers.push({ timeRemain: this.planModeLastEventTime, originalTime: this.planModeLastEventTime });
                }
            })

            return;
        }

        for (const i in this.device.comms) {
            const comm = this.device.comms[i];

            // only twin/msg require the runloop. methods are always on and not part of the runloop
            if (this.device.comms[i]._type != 'property') { continue; }

            // this is a start up event but not a runloop one. treat it differently
            if (comm.runloop && comm.runloop.onStartUp && !comm.runloop.include) {
                this.addLoopStartUpComm(comm, !this.running);
            }

            // set up runloop reporting
            if (comm.runloop && comm.runloop.include === true) {
                // Adding for back compat. This will also update the UX for any configuration missing valueMax
                // This will need an explicit reset bu remove the _ms property to change the time
                if (!comm.runloop._ms) {
                    if (!comm.runloop.valueMax) { comm.runloop.valueMax = comm.runloop.value; }

                    let newRunloopValue = 0;
                    if (comm.runloop.override) {
                        const simLoop = comm.runloop.unit === 'secs' ? this.LOOP_SECS : this.LOOP_MINS;
                        newRunloopValue = Utils.getRandomNumberBetweenRange(simLoop.min, simLoop.max, true)
                    } else {
                        newRunloopValue = Utils.getRandomNumberBetweenRange(comm.runloop.value, comm.runloop.valueMax, true);
                    }
                    comm.runloop._ms = newRunloopValue * (comm.runloop.unit === 'secs' ? 1000 : 60000);
                }

                let mockSensorTimerObject = null;

                if (comm.mock) {
                    let slice = 0;
                    let startValue = 0;
                    if (comm.mock._type != 'function') {
                        // if the sensor is a 'active' sensor then us the running expected as the start value
                        startValue = comm.mock.running && comm.mock.running > 0 ? comm.mock.running : comm.mock.init;
                    } else {
                        startValue = comm.mock.init
                        // this is a little bit of a hack to wire a function
                        comm.mock.timeToRunning = 1;
                    }

                    slice = startValue / (comm.mock.timeToRunning / 1000);
                    mockSensorTimerObject = { sliceMs: slice, remainingMs: comm.mock.timeToRunning };
                    comm.mock._value = Utils.formatValue(false, comm.mock.init);
                }

                if (comm.sdk === 'twin') {
                    this.twinRLProps.push(comm);
                    this.twinRLReportedTimers.push({ timeRemain: comm.runloop._ms, originalTime: comm.runloop._ms });
                    if (mockSensorTimerObject != null) { this.twinRLMockSensorTimers[comm._id] = mockSensorTimerObject; }
                    if (comm.runloop.onStartUp) { this.twinRLStartUpCache.push(comm._id); }
                    if (comm.runloop.onStartUp && !this.running) { this.twinRLStartUp.push(comm._id); }
                }

                if (comm.sdk === 'msg') {
                    this.msgRLProps.push(comm);
                    this.msgRLReportedTimers.push({ timeRemain: comm.runloop._ms, originalTime: comm.runloop._ms });
                    if (mockSensorTimerObject != null) { this.msgRLMockSensorTimers[comm._id] = mockSensorTimerObject; }
                    if (comm.runloop.onStartUp) { this.msgRLStartUpCache.push(comm._id); }
                    if (comm.runloop.onStartUp && !this.running) { this.msgRLStartUp.push(comm._id); }
                }
            }
        }

        this.firstSendMins = (Math.min(Math.min.apply(null, this.twinRLReportedTimers.map((v) => v.timeRemain)), Math.min.apply(null, this.msgRLReportedTimers.map((v) => v.timeRemain))) / 60000).toFixed(1);
    }

    buildIndexes() {
        this.device.comms.forEach((comm, index) => {
            this.resolversCollection.idPropToCommIndex[comm._id] = index;
            if (comm._type === 'property' && comm.sdk === 'twin' && comm.type.direction === 'c2d') {
                this.resolversCollection.nameDesiredToId[comm.name] = comm._id;
                this.resolversCollection.nameDesiredToIndex[comm.name] = index;
            }
            if (comm._type === 'method') {
                this.resolversCollection.nameMethodToId[comm.name] = comm._id;
                const key = comm.component && comm.component.enabled ? `${comm.component.name}*${comm.name}` : comm.name
                if (comm.execution === 'cloud') {
                    this.resolversCollection.nameC2dToCommIndex[key] = index;
                }
                if (comm.execution === 'direct') {
                    this.resolversCollection.nameDmToCommIndex[key] = index;
                }
            }
        })
    }

    addLoopStartUpComm(comm: any, liveUpdate: boolean) {
        let json: ValueByIdPayload = <ValueByIdPayload>{};
        let converted = Utils.formatValue(comm.string, comm.value);
        json[comm._id] = converted;
        if (comm.sdk === 'twin') {
            if (comm.runloop.onStartUp) { this.twinRLStartUpCache.push(comm._id); }
            if (comm.runloop.onStartUp && !this.running) { this.twinRLStartUp.push(comm._id); }
            if (liveUpdate) { this.updateTwin(json); }
        }
        if (comm.sdk === 'msg') {
            if (comm.runloop.onStartUp) { this.msgRLStartUpCache.push(comm._id); }
            if (comm.runloop.onStartUp && !this.running) { this.msgRLStartUp.push(comm._id); }
            if (liveUpdate) { this.updateMsg(json); }
        }
    }

    // End of device setup and update code

    updateTwin(payload: ValueByIdPayload) {
        Object.assign(this.twinRLPayloadAdditions, payload);
    }

    readTwin() {
        return this.twinDesiredPayloadRead;
    }

    readMethodParams() {
        return this.receivedMethodParams;
    }

    updateMsg(payload: ValueByIdPayload) {
        Object.assign(this.msgRLPayloadAdditions, payload);
    }

    updateEdgeModules(payload: any) {
        this.edgeRLPayloadAdditions = Object.assign({}, payload);
    }

    processMockDevicesCMD(name: string) {

        const methodName = name.toLocaleLowerCase();

        if (methodName === this.CMD_SHUTDOWN) {
            this.log('DEVICE/MODULE METHOD SHUTDOWN ... STOPPING IMMEDIATELY', LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
            this.stop();
            return;
        }

        if (methodName === this.CMD_REBOOT) {
            this.log('DEVICE/MODULE METHOD REBOOT ... RESTARTING IMMEDIATELY', LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
            this.stop();
            this.start(undefined);
            return;
        }

        if (methodName === this.CMD_FIRMWARE) {
            this.log(`DEVICE/MODULE METHOD FIRMWARE ... RESTARTING IN ${this.FIRMWARE_LOOP / 1000} SECONDS`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
            this.stop();
            setTimeout(() => {
                this.start(undefined);
            }, this.FIRMWARE_LOOP)
        }
    }

    /// BETA - remote control
    public releaseControl() { this.controlled = false; }
    waitForInstruction() {
        this.log(`DEVICE/MODULE IS BEING ASKED TO WAIT`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
        this.logCP(LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.WAITING);

        this.controlled = true;
        let waitTimer = setInterval(() => {
            if (!this.controlled) {
                this.log(`MODULE WAIT RELEASED`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
                clearInterval(waitTimer);
            }
        }, 100);
    }
    /// BETA - remote control

    /// starts a device
    start(delay: number, edgeHubName?: string) {
        if (edgeHubName) { this.edgeHubName = edgeHubName; }
        if (this.device.configuration._kind === 'template') { return; }
        if (this.delayStartTimer || this.running) { return; }

        if (delay) {
            this.log(`DEVICE/MODULE DELAYED START SECONDS: ${delay / 1000}`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
            this.logCP(LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.DELAY);
            this.delayStartTimer = setTimeout(() => {
                this.startDevice();
                setTimeout(() => {
                    clearTimeout(this.delayStartTimer);
                    this.delayStartTimer = null;
                }, 100);
            }, delay);
        } else {
            this.startDevice();
        }
    }

    /// starts a device
    async startDevice() {

        this.running = true;

        const { deviceId, moduleId } = Utils.decodeModuleKey(this.device._id);
        if (moduleId) {
            this.log('MODULE IS SWITCHED ON', LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS);
            this.logCP(LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.ON);
            this.logStat(LOGGING_TAGS.STAT.ON);
            this.iotHubDevice = { client: undefined, hubName: undefined };

            this.log('MODULE INIT', LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS);
            this.logCP(LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.TRYING);

            if (this.device.configuration._kind === 'moduleHosted' as string) {
                if (!GLOBAL_CONTEXT.IOTEDGE_WORKLOADURI && !GLOBAL_CONTEXT.IOTEDGE_DEVICEID && !GLOBAL_CONTEXT.IOTEDGE_MODULEID && !GLOBAL_CONTEXT.IOTEDGE_MODULEGENERATIONID && !GLOBAL_CONTEXT.IOTEDGE_IOTHUBHOSTNAME && !GLOBAL_CONTEXT.IOTEDGE_AUTHSCHEME) {
                    this.log(`MODULE '${moduleId}' ENVIRONMENT CHECK FAILED - MISSING IOTEDGE_*`, LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS);
                    this.log('MODULE WILL SHUTDOWN', LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
                    this.logCP(LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.OFF);
                    return;
                }

                if (GLOBAL_CONTEXT.IOTEDGE_DEVICEID != deviceId || GLOBAL_CONTEXT.IOTEDGE_MODULEID != moduleId) {
                    this.log(`MODULE '${moduleId}' DOES NOT MATCH THE MANIFEST CONFIGURATION FOR HOST DEVICE/MODULE (NOT A FAILURE)`, LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS);
                    this.log('MODULE WILL SHUTDOWN', LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
                    this.logCP(LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.OFF);
                    return;
                }

                try {
                    this.iotHubDevice.client = await ModuleClient.fromEnvironment(Protocol);
                    this.log(`MODULE '${moduleId}' CHECK PASSED. ENTERING MAIN LOOP`, LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS);
                    this.logCP(LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.CONNECTED);
                    this.mainLoop();
                } catch (err) {
                    this.log(`MODULE '${moduleId}' FAILED TO CONNECT THROUGH ENVIRONMENT TO IOT HUB: ${err}`, LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS);
                    this.log(`MODULE '${moduleId}' WILL SHUTDOWN`, LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
                    this.logCP(LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.OFF);
                } finally {
                    // For hosted modules this is all that needs to be done
                    return;
                }
            }

            if (!this.edgeHubName) {
                this.log(`MODULE '${moduleId}' CANNOT BE STARTED AS NO KNOWN HUBNAME FOR HOST. EDGE DEVICE PROBABLY FAILED TO START`, LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS);
                this.stop();
            } else {
                let transformedSasKey = this.device.configuration.isMasterKey ? this.computeDrivedSymmetricKey(this.device.configuration.gatewaySasKey, this.device.configuration.gatewayDeviceId) : this.device.configuration.gatewaySasKey;
                const registry = Registry.fromSharedAccessSignature(CommonSaS.create(this.edgeHubName, undefined, transformedSasKey, Date.now()).toString());
                try {
                    await registry.getModule(deviceId, moduleId);
                } catch (e) {
                    await registry.addModule({ deviceId, moduleId, });
                }
                this.iotHubDevice.client = Client.fromConnectionString(`HostName=${this.edgeHubName};DeviceId=${deviceId};SharedAccessKey=${transformedSasKey};ModuleId=${moduleId}`, Protocol);
                this.log(`MODULE '${moduleId}' CHECK PASSED. ENTERING MAIN LOOP`, LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS);
                this.logCP(LOGGING_TAGS.CTRL.MOD, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.CONNECTED);
                this.mainLoop();
            }
            return;
        }

        this.log('DEVICE IS SWITCHED ON', LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
        this.logCP(LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.ON);
        this.logStat(LOGGING_TAGS.STAT.ON);

        if (this.device.configuration._kind === 'dps' || this.device.configuration._kind === 'edge' || this.device.configuration._kind === 'leafDevice') {
            const simulation = this.simulationStore.get()['simulation'];
            this.dpsRetires = simulation['dpsRetries'] || 10;
            this.registrationConnectionString = null;

            this.connectionDPSTimer = setInterval(() => {
                if (this.registrationConnectionString != null && this.registrationConnectionString != 'init') {
                    clearInterval(this.connectionDPSTimer);
                    this.connectionDPSTimer = null;
                    this.connectLoop(this.registrationConnectionString);
                    return;
                }

                if (this.dpsRetires <= 0) {
                    clearInterval(this.connectionDPSTimer);
                    this.connectionDPSTimer = null;
                    this.stop();
                    this.logStat(LOGGING_TAGS.STAT.ERRORS);
                    return;
                }

                this.log('ATTEMPTING DPS REGISTRATION', LOGGING_TAGS.CTRL.DPS, LOGGING_TAGS.LOG.OPS);
                this.logCP(LOGGING_TAGS.CTRL.DPS, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.TRYING);
                this.dpsRegistration();
            }, this.CONNECT_POLL);
        }
        else {
            this.connectLoop(this.device.configuration.connectionString);
        }
    }

    connectLoop(connectionString?: string) {
        this.log('IOT HUB INITIAL CONNECT START', LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
        this.logCP(LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.INIT);
        this.connectClient(connectionString);
        if (this.plugIn) {
            this.plugIn.postConnect(this.device.configuration.deviceId);
            this.log(`DEVICE/MODULE IS USING A PLUGIN`, LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
        }
        this.reportModuleStatus({}, "start");
        this.mainLoop();
        this.connectionTimer = setInterval(() => {
            this.log('IOT HUB RECONNECT LOOP START', LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
            this.logCP(LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.INIT);
            this.logStat(LOGGING_TAGS.STAT.RESTART);
            this.CONNECT_RESTART = true;
            this.cleanUp();
            this.running = true; // Quick fix to change restart behavior
            this.connectClient(connectionString);
            this.mainLoop();
        }, this.RESTART_LOOP)
    }

    async stop() {
        if (this.delayStartTimer) {
            clearTimeout(this.delayStartTimer);
            this.delayStartTimer = null;
            this.log(`DEVICE/MODULE DELAYED START CANCELED`, LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
            this.logCP(LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.OFF);
        } else if (this.running) {
            if (this.device.configuration._kind === 'module') {
                this.log('MODULE WILL SHUTDOWN', LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
            } else {
                this.log('DEVICE WILL SHUTDOWN', LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
            }
        }
        await this.reportModuleStatus(this.edgeRLPayloadAdditions, "stop");
        this.logCP(LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.OFF);
        if (!this.running) { return; }
        if (this.plugIn) { this.plugIn.stopDevice(this.device.configuration.deviceId); }
        this.final();
    }

    final() {
        this.dpsRetires = 0;
        clearInterval(this.connectionTimer);
        this.cleanUp();
    }

    cleanUp() {
        clearInterval(this.edgeRLTimer);
        clearInterval(this.twinRLTimer);
        clearInterval(this.msgRLTimer);
        clearInterval(this.methodRLTimer);

        try {
            if (this.iotHubDevice && this.iotHubDevice.client) {
                this.iotHubDevice.client.removeAllListeners();
                this.iotHubDevice.client.close();
                this.iotHubDevice.client = null;
                this.iotHubDevice.hubName = undefined;
            }
        } catch (err) {
            this.log(`DEVICE/MODULE CLIENT TEARDOWN ERROR: ${err.message}`, LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.OPS);
            this.logStat(LOGGING_TAGS.STAT.ERRORS);
        } finally {
            this.running = false;
            this.logStat(LOGGING_TAGS.STAT.OFF);
        }
    }

    mainLoop() {
        if (!this.running) { return; }
        try {
            this.iotHubDevice.client.open(async () => {
                this.log(`IOT HUB ${this.device.configuration._kind === 'module' ? 'MODULE' : ''} CLIENT CONNECTED`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);

                this.registerDirectMethods();
                if (this.device.configuration._kind !== 'module') {
                    this.registerC2D();
                }

                this.log('IOT HUB CLIENT CONNECTED', LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
                this.log(this.device.configuration.planMode ? 'PLAN MODE' : 'INTERACTIVE MODE', LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
                this.logCP(LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.CONNECTED);

                // if we have startup events, ensure these get sent at start up again
                this.twinRLStartUp = this.twinRLStartUpCache.slice();
                this.msgRLStartUp = this.msgRLStartUpCache.slice();

                // have to scan through everything because we don't know what is twin or msg startup
                for (const i in this.device.comms) {
                    if (this.device.comms[i].runloop && this.device.comms[i].runloop.onStartUp && !this.device.comms[i].runloop.include) {
                        this.addLoopStartUpComm(this.device.comms[i], true);
                    }
                }

                this.iotHubDevice.client.getTwin((err, twin) => {

                    if (err) {
                        this.log('IOT HUB TWIN REQUEST FAILED. CLIENT IN BAD STATE', LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
                        this.stop();
                    }

                    // desired properties are cached
                    twin.on('properties.desired', ((delta) => {
                        this.logStat(LOGGING_TAGS.STAT.DESIRED);
                        _.merge(this.desiredMergedCache, delta);
                        Object.assign(this.twinDesiredPayloadRead, delta);
                        this.log(JSON.stringify(delta), LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.MSG.TWIN, LOGGING_TAGS.DATA.RECV);
                        this.CONNECT_RESTART = false;
                        this.registerDesiredProperties(delta, delta['$version'], false);
                    }))

                    if (this.device.comms.length === 0) {
                        this.log(`DEVICE/MODULE HAS NO CAPABILITIES DEFINED. DEVICE/MODULE CAN RECEIVE EVENTS BUT WILL NOT SEND ANY DATA`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
                    } else {
                        if (Utils.isNumeric(this.firstSendMins)) {
                            this.log(`LOOPS HAVE BEEN DEFINED. DATA WILL START SENDING IN ${this.firstSendMins} MINUTES`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
                        } else {
                            this.log(`NO LOOPS HAVE BEEN DEFINED. SEND DATA MANUALLY`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
                        }
                    }

                    // this loop is a poller to check a payload the will be used to send the method response 
                    // as a reported property with the same name. once it processes the payload it clears it.
                    this.methodRLTimer = setInterval(() => {
                        if (this.methodReturnPayload != null) {
                            twin.properties.reported.update(this.methodReturnPayload, ((err) => {
                                this.log(err ? err.toString() : JSON.stringify(this.methodReturnPayload), LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.MSG.TWIN, LOGGING_TAGS.DATA.SEND);
                                this.methodReturnPayload = null;
                            }))
                        }
                    }, 500);

                    // reported properties are cleared every runloop cycle
                    this.twinRLTimer = setInterval(() => {
                        let payload: ValueByIdPayload = <ValueByIdPayload>this.calcPropertyValues(this.twinRLProps, this.twinRLReportedTimers, this.twinRLMockSensorTimers, this.twinRLPropsPlanValues, this.twinRLStartUp);
                        this.runloopTwin(this.twinRLPayloadAdditions, payload, twin);
                        this.twinRLPayloadAdditions = <ValueByIdPayload>{};
                        this.twinRLStartUp = [];
                    }, 1000);
                })

                this.msgRLTimer = setInterval(() => {
                    let payload: ValueByIdPayload = null;
                    payload = <ValueByIdPayload>this.calcPropertyValues(this.msgRLProps, this.msgRLReportedTimers, this.msgRLMockSensorTimers, this.msgRLPropsPlanValues, this.msgRLStartUp);
                    this.runloopMsg(this.msgRLPayloadAdditions, payload);
                    this.msgRLPayloadAdditions = <ValueByIdPayload>{};
                    this.msgRLStartUp = [];
                }, 1000);

                // for edge, also create a loop to periodically notify module status
                if (this.device.configuration._kind === 'edge') {
                    this.edgeRLTimer = setInterval(() => {
                        this.reportModuleStatus(this.edgeRLPayloadAdditions);
                    }, 30000);
                }
            })
        }
        catch (err) {
            // this is a legacy SDK bug workaround. 99% sure it can go
            this.log(`SDK OPEN ERROR (CHECK CONN STRING): ${err.message}`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
            this.logCP(LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.ERROR);
            setTimeout(() => {
                this.stop();
            }, 5000);
        }
    }

    registerDesiredProperties(delta, version, component) {
        for (let name in delta) {
            if (name === '$version') { continue; }
            if (name === '__t') { continue; }
            if (delta[name]['__t']) {
                this.registerDesiredProperties(delta[name], version, true)
            } else {
                if (this.device.configuration.planMode) {
                    this.sendPlanResponse(this.resolversCollection.nameDesiredToId[name]);
                } else {
                    this.sendPropertyResponse(delta[name], name, version, component)
                }
            }
        }
    }

    sendPropertyResponse(sentValue, name, version, component) {
        // this deals with a full twin or a single desired
        const property: Property = this.device.comms[this.resolversCollection.nameDesiredToIndex[name]];
        if (!property) { return; }

        //REFACTOR: this needs to update the UI
        property.value = sentValue;
        property.version = version;

        //REFACTOR: this custom schema needs rethinking
        if (property.asProperty && property.asPropertyId) {
            // set up the global desired override
            if (property.asPropertyVersion) {
                this.desiredOverrides[property.asPropertyId] = <DesiredPayload>{
                    payload: property.asPropertyVersionPayload,
                    convention: property.asPropertyConvention,
                    value: sentValue,
                    version: property.version,
                    component: component
                }
            }

            // send the ack. if an override has been set, the value here will be ignored
            const p = this.device.comms.filter((x) => { return x._id === property.asPropertyId });
            // should only be 1
            for (const send in p) {
                let json: ValueByIdPayload = <ValueByIdPayload>{};
                let converted = Utils.formatValue(p[send].string, p[send].value);
                json[p[send]._id] = converted

                // if this an immediate update, send to the runloop
                if (p[send].sdk === 'twin') { this.updateTwin(json); }
                if (p[send].sdk === 'msg') { this.updateMsg(json); }
            }
        }
    }

    sendPlanResponse(propertyId) {
        // this is from the hub where desired twin contains a meta tag
        const property = this.device.plan.receive.find((prop) => { return prop.property === propertyId });
        if (property) {
            const outboundProperty: Property = this.device.comms[this.resolversCollection.idPropToCommIndex[property.propertyOut]];
            if (!outboundProperty) { return; }
            const payload = <ValueByIdPayload>{ [outboundProperty._id]: property.value }
            if (outboundProperty.sdk === 'twin') { this.updateTwin(payload); } else { this.updateMsg(payload); }
        }
    }

    sendMethodResponse(method: Method) {
        if (this.device.configuration.planMode) {
            this.sendPlanResponse(this.resolversCollection.nameMethodToId[method.name]);
        } else if (!this.device.configuration.planMode && method.asProperty && method.asPropertyId) {

            // set up the global desired override
            if (method.asPropertyVersion) {
                this.desiredOverrides[method.asPropertyId] = <DesiredPayload>{
                    payload: method.asPropertyVersionPayload,
                    convention: null,
                    value: null,
                    version: null
                }
            }

            const p = this.device.comms.filter((x) => { return x._id === method.asPropertyId });
            // should only be 1
            for (const send in p) {
                let json: ValueByIdPayload = <ValueByIdPayload>{};
                let converted = Utils.formatValue(p[send].string, p[send].value);
                json[p[send]._id] = converted

                // if this an immediate update, send to the runloop
                if (p[send].sdk === 'twin') { this.updateTwin(json); }
                if (p[send].sdk === 'msg') { this.updateMsg(json); }
            }
        } else if (!this.device.configuration.planMode && method.asProperty) {
            this.methodReturnPayload = Object.assign({}, { [method.name]: method.payload })
        }

        // intentional delay to allow any properties to be sent
        setTimeout(() => {
            this.processMockDevicesCMD(method.name);
        }, 2000);
    }

    registerC2D() {
        this.iotHubDevice.client.on('message', (msg) => {
            if (msg === undefined || msg === null) { return; }

            let error = false;
            try {
                const cloudName = msg.properties.getValue('method-name');
                const cloudNameParts = cloudName.split(':');
                const cloudMethod = cloudNameParts.length === 2 ? cloudNameParts[1] : cloudNameParts[0]
                let cloudMethodPayload = msg.data.toString();
                try {
                    cloudMethodPayload = JSON.parse(cloudMethodPayload);
                } catch (err) { }

                if (this.resolversCollection.nameC2dToCommIndex[cloudMethod]) {
                    const method: Method = this.device.comms[this.resolversCollection.nameC2dToCommIndex[cloudMethod]];
                    this.log(cloudMethod + ' ' + JSON.stringify(cloudMethodPayload), LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.DATA.METH, LOGGING_TAGS.DATA.RECV, 'C2D REQUEST AND PAYLOAD');
                    this.logStat(LOGGING_TAGS.STAT.C2D);
                    Object.assign(this.receivedMethodParams, { [method._id]: { date: new Date().toUTCString(), payload: JSON.stringify(cloudMethodPayload, null, 2) } });

                    this.sendMethodResponse(method);
                }
            }
            catch (err) {
                error = true;
                this.log(`${err.toString()}`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.DATA.METH, LOGGING_TAGS.DATA.SEND, 'C2D ERROR PARSING MESSAGE BODY');
            }

            this.iotHubDevice.client.complete(msg, (err) => {
                this.log(`${err ? err.toString() : error ? 'FAILED' : 'SUCCESS'}`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS, null, 'C2D COMPLETE');
            });
        });
    }

    registerDirectMethods() {
        for (const key in this.resolversCollection.nameDmToCommIndex) {
            const clientMethodKey = this.iotHubDevice.client['onDeviceMethod'] ? 'onDeviceMethod' : 'onMethod';
            this.iotHubDevice.client[clientMethodKey](key, (request, response) => {
                const method: Method = this.device.comms[this.resolversCollection.nameDmToCommIndex[key]];
                const methodPayload = JSON.parse(method.payload || {});

                this.log(`${request.methodName} : ${request.payload ? JSON.stringify(request.payload) : '<NO PAYLOAD>'}`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.DATA.METH, LOGGING_TAGS.DATA.RECV, 'DIRECT METHOD REQUEST AND PAYLOAD');
                Object.assign(this.receivedMethodParams, { [method._id]: { date: new Date().toUTCString(), payload: request.payload } });

                // this response is the payload of the device
                response.send((parseInt(method.status)), methodPayload, (err) => {
                    this.log(err ? err.toString() : `${method.name} -> [${method.status}] ${JSON.stringify(methodPayload)}`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.DATA.METH, LOGGING_TAGS.DATA.SEND, 'DIRECT METHOD RESPONSE PAYLOAD');
                    this.logStat(LOGGING_TAGS.STAT.COMMANDS);
                    this.messageService.sendAsLiveUpdate(this.device._id, { [method._id]: new Date().toUTCString() });

                    this.sendMethodResponse(method);
                })
            });
        }
    }

    // EDGE
    connectClient(connectionString) {
        this.iotHubDevice = { client: undefined, hubName: undefined };

        if (this.useSasMode) {
            const cn = ConnectionString.parse(connectionString);

            let sas: any = SharedAccessSignature.create(cn.HostName, cn.DeviceId, cn.SharedAccessKey, this.sasTokenExpiry);
            this.iotHubDevice.client = Client.fromSharedAccessSignature(sas, M1);
            this.iotHubDevice.hubName = cn.HostName;

            const trueHours = Math.ceil((this.sasTokenExpiry - Math.round(Date.now() / 1000)) / 3600);
            this.log(`CONNECTING VIA SAS.TOKEN EXPIRES AFTER ${trueHours} HOURS`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
        } else {
            // get a connection string from the RP in the Portal
            this.iotHubDevice.client = clientFromConnectionString(connectionString);
            // store hub name
            this.iotHubDevice.hubName = ConnectionString.parse(connectionString).HostName;
            this.log(`CONNECTING VIA CONN STRING`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
        }
        this.logStat(LOGGING_TAGS.STAT.CONNECTS);
        this.log(`DEVICE/MODULE AUTO RESTARTS EVERY ${this.RESTART_LOOP / 60000} MINUTES`, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.LOG.OPS);
    }

    // EDGE
    dpsRegistration() {
        if (this.registrationConnectionString === 'init') { return; }
        if (this.dpsRetires === 0) { return; }

        let config = this.device.configuration;
        this.iotHubDevice = { client: undefined, hubName: undefined };
        this.registrationConnectionString = 'init';

        let transformedSasKey = config.isMasterKey ? this.computeDrivedSymmetricKey(config.sasKey, config.deviceId) : config.sasKey;

        let dpsPayload = {};
        if (config.dpsPayload) {
            try {
                dpsPayload = JSON.parse(config.dpsPayload);
            }
            catch {
                dpsPayload = config.dpsPayload;
            }
        }

        let provisioningSecurityClient = new SymmetricKeySecurityClient(config.deviceId, transformedSasKey);
        let provisioningClient = ProvisioningDeviceClient.create('global.azure-devices-provisioning.net', config.scopeId, new MqttDps(), provisioningSecurityClient);

        provisioningClient.setProvisioningPayload(dpsPayload);
        this.log('WAITING FOR REGISTRATION', LOGGING_TAGS.CTRL.DPS, LOGGING_TAGS.LOG.OPS);
        this.logCP(LOGGING_TAGS.CTRL.DPS, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.TRYING);
        provisioningClient.register((err: any, result) => {
            if (err) {
                let msg = (err.result && err.result.registrationState && err.result.registrationState.errorMessage) || err;
                this.log(`REGISTRATION ERROR ${this.dpsRetires}: ${msg}`, LOGGING_TAGS.CTRL.DPS, LOGGING_TAGS.LOG.OPS);
                this.logCP(LOGGING_TAGS.CTRL.DPS, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.ERROR);
                this.registrationConnectionString = null;
                this.dpsRetires--;
                return;
            }
            this.registrationConnectionString = 'HostName=' + result.assignedHub + ';DeviceId=' + result.deviceId + ';SharedAccessKey=' + transformedSasKey;
            if (this.device.configuration._kind === 'leafDevice') {
                this.registrationConnectionString += `;GatewayId=${this.device.configuration.gatewayDeviceId}`;
            }
            this.log('DEVICE REGISTRATION SUCCESS', LOGGING_TAGS.CTRL.DPS, LOGGING_TAGS.LOG.OPS);
            this.logCP(LOGGING_TAGS.CTRL.DPS, LOGGING_TAGS.LOG.OPS, LOGGING_TAGS.LOG.EV.SUCCESS);
            this.logStat(LOGGING_TAGS.STAT.DPS);
        })
    }

    // creates the HMAC key
    computeDrivedSymmetricKey(masterKey, regId) {
        return Crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64'))
            .update(regId, 'utf8')
            .digest('base64');
    }

    /// runs the device
    async runloopTwin(additions: ValueByIdPayload, payload: any, twin?: any) {

        if (payload != null) {
            Object.assign(payload, additions);

            if (Object.keys(payload).length > 0) {
                const transformed = this.transformPayload(payload);
                for (const c in transformed.package) {
                    let sub = '';
                    let data = transformed.package[c];
                    if (c != "_root") {
                        data = { [c]: data }
                        data[c]["__t"] = "c";
                        sub = c;
                    }
                    try {
                        twin.properties.reported.update(data, ((err) => {
                            this.log(JSON.stringify(data), LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.MSG.TWIN, LOGGING_TAGS.DATA.SEND, sub);
                            this.logStat(LOGGING_TAGS.STAT.TWIN.COUNT);
                            this.messageService.sendAsLiveUpdate(this.device._id, transformed.live);
                        }));
                    } catch (error) {
                        // sometimes the close connection throw error, add logs for better understanding
                        this.log(`SDK CLOSE ERROR: ${error.message}`, LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.EV.OFF);
                        setTimeout(() => {
                            this.stop();
                        }, 5000);
                    }
                }
            }
        }
    }

    /// runs the device
    async runloopMsg(additions: ValueByIdPayload, payload) {
        if (payload != null) {
            Object.assign(payload, additions);

            if (Object.keys(payload).length > 0) {
                const transformed = this.transformPayload(payload);
                for (const c in transformed.package) {
                    const data = JSON.stringify(transformed.package[c]);
                    let sub = '';
                    let msg = new Message(data);
                    msg.contentType = 'application/json';
                    msg.contentEncoding = 'utf-8';
                    if (c != "_root") { msg.properties.add('$.sub', c); sub = c; }
                    try {
                        this.iotHubDevice.client.sendEvent(msg, ((err) => {
                            this.log(data, LOGGING_TAGS.CTRL.HUB, LOGGING_TAGS.MSG.MSG, LOGGING_TAGS.DATA.SEND, sub);
                            this.logStat(LOGGING_TAGS.STAT.MSG.COUNT);
                            this.messageService.sendAsLiveUpdate(this.device._id, transformed.live);
                        }));
                    } catch (error) {
                        // sometimes the close connection throw error, add logs for better understanding
                        this.log(`SDK CLOSE ERROR: ${error.message}`, LOGGING_TAGS.CTRL.DEV, LOGGING_TAGS.LOG.EV.OFF);
                        setTimeout(() => {
                            this.stop();
                        }, 5000);
                    }
                }
            }
        }
    }

    async reportModuleStatus(additions: any, override?: string) {

        if (this.device.configuration._kind !== 'edge') { return; }

        const Agent_Running = 'running';
        const Agent_Stopped = 'stopped';

        let transformedSasKey = this.device.configuration.isMasterKey ? this.computeDrivedSymmetricKey(this.device.configuration.sasKey, this.device.configuration.deviceId) : this.device.configuration.sasKey;
        const edgeAgentClient = Client.fromConnectionString(`HostName=${this.iotHubDevice.hubName};DeviceId=${this.device.configuration.deviceId};SharedAccessKey=${transformedSasKey};ModuleId=$edgeAgent`, Protocol);

        try {
            await edgeAgentClient.open();
            const edgeAgentTwin = await edgeAgentClient.getTwin();

            const modules = {};
            for (const module in additions) {
                const modState = override && override === 'start' ? Agent_Running : override && override === 'stop' ? Agent_Stopped : additions[module] ? Agent_Running : Agent_Stopped;
                modules[module] = { runtimeStatus: modState };
            }

            const sysState = override && override === 'start' ? Agent_Running : override && override === 'stop' ? Agent_Stopped : this.running ? Agent_Running : Agent_Stopped;
            await edgeAgentTwin.properties.reported.update({
                systemModules: {
                    edgeAgent: { runtimeStatus: sysState },
                    edgeHub: { runtimeStatus: sysState },
                },
                modules
            });

        } catch (err) {
            if (this.running) {
                this.log('CANNOT UPDATE MODULES STATUS. EDGE DEVICE SHOULD BE RESTARTED', LOGGING_TAGS.CTRL.EDG, LOGGING_TAGS.LOG.EV.ERROR);
            }
        } finally {
            await edgeAgentClient.close();
        }
    }

    calcPropertyValues(runloopProperties: any, runloopTimers: any, propertySensorTimers: any, runloopPropertiesValues: any, startUpList: Array<string>) {
        if (this.iotHubDevice === null || this.iotHubDevice.client === null) {
            clearInterval(this.msgRLTimer);
            return null;
        }

        // first get all the values to report
        let payload = {};
        for (const i in runloopProperties) {

            // this is a paired structure
            let p: Property = runloopProperties[i];
            let { timeRemain, originalTime } = runloopTimers[i]
            let possibleResetTime = runloopTimers[runloopTimers.length - 1].timeRemain + originalTime;
            let res = this.processCountdown(p, timeRemain, possibleResetTime, startUpList);
            runloopTimers[i] = { 'timeRemain': res.timeRemain, originalTime };

            // for plan mode we send regardless of enabled or not
            if (res.process && (this.device.configuration.planMode || p.enabled)) {
                let o: ValueByIdPayload = <ValueByIdPayload>{};
                o[p._id] = this.device.configuration.planMode ? Utils.formatValue(p.string, runloopPropertiesValues[i]) : (p.mock ? p.mock._value || Utils.formatValue(false, p.mock.init) : Utils.formatValue(p.string, p.value));
                Object.assign(payload, o);
            }

            this.updateSensorValue(p, propertySensorTimers, res.process);
        }
        return payload;
    }

    async updateSensorValue(p: Property, propertySensorTimers: any, process: boolean) {

        // sensors are not supported in plan mode yet
        if (p.mock === undefined) { return; }

        let slice = 0;
        let randomFromRange = Utils.getRandomNumberBetweenRange(1, 10, false);

        // this block deals with calculating the slice val to apply to the current sensor value
        if (propertySensorTimers[p._id]) {
            slice = propertySensorTimers[p._id].sliceMs;
            let sliceRemaining = propertySensorTimers[p._id].remainingMs - 1000;

            if (sliceRemaining > 0) {
                propertySensorTimers[p._id].remaining = sliceRemaining;
            } else {
                delete propertySensorTimers[p._id];
            }
        } else {
            slice = p.mock._value;
        }

        /* very simple calculations on line to give them some realistic behavior */

        if (p.mock._type === 'fan') {
            var variance = p.mock.variance / p.mock.running * 100;
            p.mock._value = randomFromRange >= 5 ? p.mock.running - variance : p.mock.running + variance;
        }

        if (p.mock._type === 'hotplate') {
            if (p.mock.reset && Utils.isNumeric(p.mock.reset) && Utils.formatValue(false, p.mock.reset) === p.mock._value) {
                p.mock._value = Utils.formatValue(false, p.mock.init);
            } else {
                var newCurrent = p.mock._value + (slice - (slice * p.mock.variance));
                p.mock._value = newCurrent <= p.mock.running ? newCurrent : p.mock.running;
            }
        }

        if (p.mock._type === 'battery') {
            if (p.mock.reset && Utils.isNumeric(p.mock.reset) && Utils.formatValue(false, p.mock.reset) === p.mock._value) {
                p.mock._value = Utils.formatValue(false, p.mock.init);
            } else {
                var newCurrent = p.mock._value - (slice + (slice * p.mock.variance));
                p.mock._value = newCurrent > p.mock.running ? newCurrent : p.mock.running;
            }
        }

        if (p.mock._type === 'random') {
            p.mock._value = Math.floor(Math.random() * Math.floor(Math.pow(10, p.mock.variance) + 1));
        }

        if (p.mock._type === 'function' && process) {
            const res: any = await this.getFunctionPost(p.mock.function, p.mock._value);
            p.mock._value = res;
        }

        if (p.mock._type === 'inc' && process) {
            const inc = p.mock.variance && Utils.isNumeric(p.mock.variance) ? Utils.formatValue(false, p.mock.variance) : 1;
            if (p.mock.reset && Utils.isNumeric(p.mock.reset) && Utils.formatValue(false, p.mock.reset) === p.mock._value) {
                p.mock._value = Utils.formatValue(false, p.mock.init);
            } else {
                p.mock._value = p.mock._value + inc;
            }
        }

        if (p.mock._type === 'dec' && process) {
            const dec = p.mock.variance && Utils.isNumeric(p.mock.variance) ? Utils.formatValue(false, p.mock.variance) : 1;
            if (p.mock.reset && Utils.isNumeric(p.mock.reset) && Utils.formatValue(false, p.mock.reset) === p.mock._value) {
                p.mock._value = Utils.formatValue(false, p.mock.init);
            } else {
                p.mock._value = p.mock._value - dec;
            }
        }
    }

    getFunctionPost(url: string, value: any) {
        return new Promise((resolve, reject) => {
            try {
                request.post({
                    headers: { 'content-type': 'application/json' },
                    url: url,
                    body: JSON.stringify({ 'value': value })
                }, (err, response, body) => {
                    if (err) {
                        this.log(`FUNCTION ERROR: ${err.toString()}`, LOGGING_TAGS.DATA.FNC, '', LOGGING_TAGS.DATA.SEND);
                        reject(err);
                    }
                    else {
                        let payload = JSON.parse(body);
                        resolve(payload.value ? parseFloat(payload.value) : payload.body);
                    }
                });
            }
            catch (err) {
                this.log(`FUNCTION FAILED: ${err.toString()}`, LOGGING_TAGS.DATA.FNC, '', LOGGING_TAGS.DATA.SEND);
                reject(err);
            }
        })
    }

    processCountdown(p: Property, timeRemain, originalPlanTime, startUpList: Array<string>) {

        let res: any = {};

        // countdown and go to next property
        if (timeRemain != 0) {
            timeRemain = timeRemain - 1000;
            res.process = false;

            // if this is a start up event then send the value regardless of time remain
            if (startUpList.indexOf(p._id) > -1) {
                res.timeRemain = timeRemain;
                res.process = true;
                return res;
            }
        }

        // reset and process
        if (timeRemain === 0) {
            if (this.device.configuration.planMode) {
                timeRemain = this.device.plan.loop ? originalPlanTime : -1;
            } else {
                timeRemain = p.runloop._ms;
            }
            res.process = true;
        }

        res.timeRemain = timeRemain;
        return res;
    }

    transformPayload(payload: any) {
        // if the name is duped then last one wins. this is ok for now
        // but a better solution is required.
        let remap = { package: {}, legacy: {}, live: {} };

        for (const item in payload) {
            const index = this.resolversCollection.idPropToCommIndex[item];
            const p: Property = this.device.comms[index];

            if (p && p.propertyObject) {
                var val = p.string ? "\"" + payload[p._id] + "\"" : payload[p._id];
                var component = p.component && p.component.enabled ? p.component.name : null;
                if (component && !remap.package[component]) { remap.package[component] = {} }
                if (!component && !remap.package["_root"]) { remap.package["_root"] = {} }

                if (this.plugIn) {
                    const val = p.propertyObject.type === 'templated' ? JSON.parse(p.propertyObject.template) : payload[p._id];
                    const res = this.plugIn.propertyResponse(this.device.configuration.deviceId, p, val);

                    if (res !== undefined) {
                        remap.legacy[p.name] = res;
                        remap.live[p._id] = res;
                        remap.package[component ? component : '_root'][p.name] = res;
                        continue;
                    }
                }

                /* REFACTOR: this concept does not scale well. desired and reported for a setting
                   are separate items in the array therefore there is no concept of version when the event
                   loop arrives here. Address in V6 */
                if (this.desiredOverrides[p._id]) {
                    const sendOverrides: DesiredPayload = this.desiredOverrides[p._id];
                    let override: any = null;
                    try {
                        override = JSON.parse(sendOverrides.payload);
                        // if this is an object then its probably a legacy desired property which is value wrapped
                        if (sendOverrides.convention && (typeof sendOverrides.value === 'object' && sendOverrides.value !== null)) { Object.assign(override, sendOverrides.value) }
                        this.resolveRandom(override, sendOverrides);
                    } catch (err) {
                        override = this.resolveAuto(sendOverrides.payload, sendOverrides)
                        // this can be ignored
                    }
                    remap.legacy[p.name] = override;
                    remap.live[p._id] = override;
                    remap.package[component ? component : '_root'][p.name] = override;
                    delete this.desiredOverrides[p._id];
                } else if (p.propertyObject.type === 'templated') {
                    try {
                        var replacement = p.propertyObject.template.replace(new RegExp(/\"AUTO_VALUE\"/, 'g'), val);
                        var object = JSON.parse(replacement);
                        this.resolveRandom(object)
                        remap.legacy[p.name] = object;
                        remap.live[p._id] = object;
                        remap.package[component ? component : '_root'][p.name] = object;
                    } catch (ex) {
                        const err = 'ERR - transformPayload: ' + ex;
                        remap.legacy[p.name] = err;
                        remap.live[p._id] = err;
                        remap.package[component ? component : '_root'][p.name] = err;
                    }
                } else {
                    const resolve = this.resolveAuto(payload[p._id]);;
                    remap.legacy[p.name] = resolve;
                    remap.live[p._id] = resolve;
                    remap.package[component ? component : '_root'][p.name] = resolve;
                }
            } else {
                //TODO: deprecate?
                const resolve = this.resolveAuto(payload[p._id]);;
                remap.legacy[p.name] = resolve;
                remap.live[p._id] = resolve;
                remap.package[component ? component : '_root'][p.name] = resolve;
            }
        }
        return remap;
    }

    resolveAuto(macro: string, parameters?: any) {
        if (macro === 'AUTO_STRING') {
            return rw();
        } else if (macro === 'AUTO_BOOLEAN') {
            return Utils.getRandomValue('boolean');
        } else if (macro === 'AUTO_INTEGER' || macro === 'AUTO_LONG') {
            return Utils.getRandomValue('integer', this.ranges['AUTO_INTEGER']['min'], this.ranges['AUTO_INTEGER']['max']);
        } else if (macro === 'AUTO_DOUBLE' || (macro === 'AUTO_FLOAT')) {
            return Utils.getRandomValue('double', this.ranges['AUTO_DOUBLE']['min'], this.ranges['AUTO_DOUBLE']['max']);
        } else if (macro === 'AUTO_DATE') {
            return Utils.getRandomValue('date')
        } else if (macro === 'AUTO_DATETIME') {
            return Utils.getRandomValue('dateTime')
        } else if (macro === 'AUTO_TIME' || macro === 'AUTO_DURATION') {
            return Utils.getRandomValue('time')
        } else if (macro === 'AUTO_GEOPOINT') {
            return Utils.getRandomGeo(this.geo['latitude'], this.geo['longitude'], this.geo['altitude'], this.geo['radius'])
        } else if (macro === 'AUTO_VECTOR') {
            return Utils.getRandomVector(this.ranges['AUTO_VECTOR']['min'], this.ranges['AUTO_VECTOR']['max']);
        } else if (macro === 'AUTO_MAP') {
            return Utils.getRandomMap()
        } else if (macro && macro.toString().startsWith('AUTO_ENUM')) {
            let parts = macro.split('/');
            if (parts.length === 2 && parts[0] === 'AUTO_ENUM') {
                let arr = JSON.parse(parts[1]);
                const index = Utils.getRandomNumberBetweenRange(0, arr.length, true)
                return arr[index];
            }
        } else if (macro === 'DESIRED_VALUE') {
            return parameters.value;
        } else if (macro === 'DESIRED_VERSION') {
            return parameters.version;
        }
        return macro;
    }

    resolveRandom(node: any, parameters?: any) {
        for (let key in node) {
            if (typeof node[key] == 'object') {
                this.resolveRandom(node[key], parameters)
            } else {
                node[key] = this.resolveAuto(node[key], parameters);
            }
        }
    }

    log(message, type, operation, direction?, submsg?) {
        let msg = `[${type}][${operation}][${this.device._id}]`;
        if (direction) { msg += `[${direction}]` }
        if (submsg) { msg += `[${submsg}]` }
        this.messageService.sendConsoleUpdate(`${msg} ${message}`)
    }

    logCP(type, operation, event) {
        this.previousControlStatus = this.currentControlStatus;
        this.messageService.sendAsControlPlane({ [this.device._id]: [type, operation, event] });
        this.currentControlStatus = event;
    }

    logStat(type) {
        const parts = type.split('_');
        const update = parts.length === 2 ? parts[0] : 'METER';
        const date = new Date().toISOString();

        if (update === 'MSG' && !this.stats.MSG_FIRST) { this.stats.MSG_FIRST = date; }
        if (update === 'TWIN' && !this.stats.TWIN_FIRST) { this.stats.TWIN_FIRST = date; }

        if (update === 'MSG') { this.stats.MSG_LAST = date; }
        if (update === 'TWIN') { this.stats.TWIN_LAST = date; }

        this.stats[type] = this.stats[type] + 1;
        if (this.stats.MSG_FIRST && this.stats.MSG_LAST && update === 'MSG') {
            const s = Date.parse(this.stats.MSG_FIRST);
            const f = Date.parse(this.stats.MSG_LAST);
            this.stats[LOGGING_TAGS.STAT.MSG.RATE] = (this.stats[type] / (Math.round((f - s) / 60000))).toFixed(2)
        }

        if (this.stats.TWIN_FIRST && this.stats.TWIN_LAST && update === 'TWIN') {
            const s = Date.parse(this.stats.TWIN_FIRST);
            const f = Date.parse(this.stats.TWIN_LAST);
            this.stats[LOGGING_TAGS.STAT.TWIN.RATE] = (this.stats[type] / (Math.round((f - s) / 60000))).toFixed(2)
        }

        this.messageService.sendAsStats({ [this.device._id]: this.stats });
    }
}