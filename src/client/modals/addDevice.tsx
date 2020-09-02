var classNames = require('classnames');
import "react-toggle/style.css"

const cxM = classNames.bind(require('./modal.scss'));
const cx = classNames.bind(require('./addDevice.scss'));
import { Endpoint } from '../context/endpoint';

import * as React from 'react';
import { Combo, Json } from '../ui/controls';
import axios from 'axios';
import Toggle from 'react-toggle';
import { DeviceContext } from '../context/deviceContext';
import { RESX } from '../strings';

const initialState = {
    _kind: '',
    _deviceList: [],
    deviceId: '',
    mockDeviceName: '',
    mockDeviceCount: 1,
    mockDeviceCountMax: 1,
    mockDeviceCloneId: '',
    connectionString: '',
    scopeId: '',
    dpsPayload: '',
    sasKey: '',
    isMasterKey: false,
    capabilityModel: '',
    capabilityUrn: '',
    machineState: '',
    machineStateClipboard: '',
    pnpSdk: false
}

export const AddDevice: React.FunctionComponent<any> = ({ handler }) => {
    const deviceContext: any = React.useContext(DeviceContext);

    const [panel, setPanel] = React.useState(0);
    const [state, setPayload] = React.useState(initialState);
    const [merge, setMerge] = React.useState(false);
    const [jsons, setJsons] = React.useState<any>({});
    const [error, setError] = React.useState<any>('');

    React.useEffect(() => {
        let list = [];
        axios.get(`${Endpoint.getEndpoint()}api/devices`)
            .then((response: any) => {
                list.push({ name: RESX.modal.add.option1.select, value: null });
                response.data.map(function (ele: any) {
                    list.push({ name: ele.configuration.mockDeviceName, value: ele._id });
                });
                return axios.get(`${Endpoint.getEndpoint()}api/state`);
            })
            .then((response: any) => {
                setPayload({
                    ...state,
                    _deviceList: list,
                    machineStateClipboard: response.data
                })
            })
    }, []);

    const clickAddDevice = (kind: string) => {
        state._kind = kind;
        state.machineStateClipboard = null;
        for (const j in jsons) {
            state[j] = jsons[j]
        }
        axios.post(`${Endpoint.getEndpoint()}api/device/new`, state)
            .then(res => {
                deviceContext.setDevices(res.data);
                handler(false);
            })
            .catch((err) => {
                const msg = err.response && err.response.data && err.response.data.message || RESX.modal.add.error_generic_add;
                setError(msg);
            })
    }

    const toggleMasterKey = () => {
        setPayload({
            ...state,
            isMasterKey: !state.isMasterKey
        });
    }

    const updateField = e => {
        let node = {};
        switch (e.target.name) {
            case 'deviceId':
                node = { [e.target.name]: e.target.value, 'mockDeviceName': e.target.value };
                break;
            default:
                node = { [e.target.name]: e.target.value };
        }
        setPayload({
            ...state,
            ...node
        });
    }

    const getTemplate = (id: string) => {
        axios.get(`${Endpoint.getEndpoint()}api/device/${id}`)
            .then(response => {
                const json = response.data;

                if (json == '') {
                    setPayload(Object.assign({}, initialState, { _deviceList: state._deviceList }));
                    return;
                }

                let payload: any = {}
                payload.scopeId = json.configuration.scopeId
                payload.capabilityUrn = json.configuration.capabilityUrn
                payload.mockDeviceCloneId = id

                if (state.pnpSdk) {
                    payload.dpsPayload = { "__iot:interfaces": { "CapabilityModelId": json.configuration.capabilityUrn } }
                } else {
                    payload.dpsPayload = { "iotcModelId": json.configuration.capabilityUrn }
                }

                if (json.configuration.isMasterKey) {
                    payload.sasKey = json.configuration.sasKey;
                    payload.isMasterKey = true;
                }

                setPayload(Object.assign({}, state, payload));
                document.getElementById('device-id').focus();
            })
    }


    const loadFromDisk = (file: string) => {
        axios.get(`${Endpoint.getEndpoint()}api/openDialog`)
            .then(response => {
                const json = response.data;
                if (file === 'machineState') {
                    axios.post(`${Endpoint.getEndpoint()}api/state/${merge ? 'merge' : ''}`, json)
                        .then(() => {
                            deviceContext.refreshAllDevices();
                            handler(false);
                        })
                        .catch((err) => {
                            setError(RESX.modal.add.error_load);
                        })
                } else {
                    setPayload({
                        ...state,
                        [file]: json
                    })
                }
            })
    }

    const updateJson = (text: any, type: string) => {
        setJsons({ ...jsons, [type]: text });
        setError('');
    }

    const selectPanel = (panelNumber: number) => {
        setPanel(panelNumber);
        setError('');
    }

    /* State Machine */

    const updateCurrentState = (nextState) => {
        if (error === '') {
            axios.post(`${Endpoint.getEndpoint()}api/state/${merge ? 'merge' : ''}`, jsons[nextState])
                .then(() => {
                    deviceContext.refreshAllDevices();
                    handler(false);
                })
                .catch((err) => {
                    setError(RESX.modal.add.error_state);
                })
        }
    }

    const saveToDisk = () => {
        axios.post(`${Endpoint.getEndpoint()}api/saveDialog`, state.machineStateClipboard, { headers: { 'Content-Type': 'application/json' } })
            .then(() => {
                handler(false);
            })
            .catch((err) => {
                setError(RESX.modal.add.error_file);
            })
    }

    return <div className='m-modal'>
        <div className='m-close' onClick={() => handler(false)}><i className='fas fa-times'></i></div>
        <div className='m-content'>
            <div className='add-device'>
                <div className='m-tabbed-nav' style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div className='menu-vertical' >
                        <label>{RESX.modal.add.option1.title}</label>
                        <button title={RESX.modal.add.option1.buttons.button1_title} onClick={() => selectPanel(0)} className={cx('btn btn-outline-primary', panel === 0 ? 'active' : '')}>{RESX.modal.add.option1.buttons.button1_label}</button><br />
                        <button title={RESX.modal.add.option1.buttons.button2_title} onClick={() => selectPanel(1)} className={cx('btn btn-outline-primary', panel === 1 ? 'active' : '')}>{RESX.modal.add.option1.buttons.button2_label}</button><br />
                        <label>{RESX.modal.add.option2.title}</label>
                        <button title={RESX.modal.add.option2.buttons.button1_title} onClick={() => selectPanel(2)} className={cx('btn btn-outline-primary', panel === 2 ? 'active' : '')}>{RESX.modal.add.option2.buttons.button1_label}</button><br />
                        <button title={RESX.modal.add.option2.buttons.button2_title} onClick={() => selectPanel(3)} className={cx('btn btn-outline-primary', panel === 3 ? 'active' : '')}>{RESX.modal.add.option2.buttons.button2_label}</button><br />
                        <label>{RESX.modal.add.option3.title}</label>
                        {deviceContext.ui.container ? null : <>
                            <button title={RESX.modal.add.option3.buttons.button1_title} onClick={() => selectPanel(4)} className={cx('btn btn-outline-primary', panel === 4 ? 'active' : '')}>{RESX.modal.add.option3.buttons.button1_label}</button><br />
                        </>}
                        <button title={RESX.modal.add.option3.buttons.button2_title} onClick={() => selectPanel(5)} className={cx('btn btn-outline-primary', panel === 5 ? 'active' : '')}>{RESX.modal.add.option3.buttons.button2_label}</button><br />
                        <label>{RESX.modal.add.option4.title}</label>
                        <button title={RESX.modal.add.option4.buttons.button1_title} onClick={() => selectPanel(6)} className={cx('btn btn-outline-primary', panel === 6 ? 'active' : '')}>{RESX.modal.add.option4.buttons.button1_label}</button><br />
                    </div>
                    <div className='form-group'>
                        {deviceContext.ui.container ? <><label>{Endpoint.getEndpoint()}</label><br /><i className="fab fa-docker fa-2x fa-fw" /></> : null}
                        <span className='error'>{error}</span>
                    </div>
                </div>

                <div className='m-tabbed-panel'>
                    {panel !== 0 ? null : <>
                        <div className='m-tabbed-panel-form'>

                            <div className='form-group'>
                                <label>{RESX.modal.add.option1.label.clone}</label><br />
                                <Combo items={state._deviceList} cls='custom-textarea-sm' name='mockDeviceCloneId' onChange={(e) => getTemplate(e.target.value)} value={state.mockDeviceCloneId || ''} />
                            </div>
                            <div className='form-group'>
                                <label>{RESX.modal.add.option1.label.deviceId}</label><br />
                                <input autoFocus={true} id="device-id" className='form-control form-control-sm' type='text' name='deviceId' onChange={updateField} value={state.deviceId || ''} />
                            </div>

                            <div className='form-group' style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <div className='form-group' style={{ paddingRight: '20px' }} >
                                    <div className='form-group'>
                                        <label>{RESX.modal.add.option1.label.dps}</label>
                                        <input className='form-control form-control-sm' type='text' name='scopeId' onChange={updateField} value={state.scopeId || ''} />
                                    </div>
                                    <div className='form-group'>
                                        <label>{RESX.modal.add.option1.label.sas}</label>
                                        <input className='form-control form-control-sm' type='text' name='sasKey' onChange={updateField} value={state.sasKey || ''} />
                                    </div>
                                    <div className='form-group'>
                                        <label>{RESX.modal.add.option1.label.root}</label>
                                        <div><Toggle name='masterKey' checked={state.isMasterKey} defaultChecked={false} onChange={() => { toggleMasterKey() }} /></div>
                                    </div>
                                </div>
                                <div className='form-group'>
                                    <label>{RESX.modal.add.option1.label.dps}</label>
                                    <div className='form-group'>
                                        <Json json={state.dpsPayload} cb={(text: any) => { updateJson(text, 'dpsPayload') }} err={() => setError(RESX.modal.error_json)} />
                                    </div>
                                </div>
                            </div>

                            <div className='form-group' style={{ display: 'flex', alignContent: 'stretch' }}>
                                <div className='form-group' style={{ paddingRight: '10px' }} >
                                    <label>{RESX.modal.add.option1.label.bulk_from}</label><br />
                                    <input className='form-control form-control-sm' type='number' name='mockDeviceCount' disabled={!state.isMasterKey} onChange={updateField} value={state.mockDeviceCount || ''} />
                                </div>
                                <div className='form-group'>
                                    <label>{RESX.modal.add.option1.label.bulk_to}</label><br />
                                    <input className='form-control form-control-sm' type='number' name='mockDeviceCountMax' disabled={!state.isMasterKey} onChange={updateField} value={state.mockDeviceCountMax || ''} />
                                </div>
                            </div>

                            <div className='form-group'>
                                <label>{RESX.modal.add.option1.label.friendly}</label>
                                <input className='form-control form-control-sm' type='text' name='mockDeviceName' onChange={updateField} value={state.mockDeviceName || ''} />
                            </div>

                        </div>
                        <div className='m-tabbed-panel-footer'>
                            <button title={RESX.modal.add.option1.cta_title} className='btn btn-info' disabled={state.scopeId == '' || state.deviceId == '' || state.sasKey == '' || (state.pnpSdk && state.capabilityUrn === '')} onClick={() => clickAddDevice('dps')}>{RESX.modal.add.option1.cta_label}</button>
                        </div>
                    </>}

                    {panel !== 1 ? null : <>
                        <div className='m-tabbed-panel-form'>
                            <div className='form-group'>
                                <label>{RESX.modal.add.option1.label.clone}</label><br />
                                <Combo items={state._deviceList} cls='custom-textarea-sm' name='mockDeviceCloneId' onChange={updateField} value={state.mockDeviceCloneId || ''} />
                            </div>
                            <div className='form-group'>
                                <label>{RESX.modal.add.option1.label.connstr}</label>
                                <textarea className='custom-textarea form-control form-control-sm' name='connectionString' rows={4} onChange={updateField} value={state.connectionString || ''}></textarea>
                            </div>
                            <div className='form-group'>
                                <label>{RESX.modal.add.option1.label.friendly_sm}</label>
                                <input className='form-control form-control-sm' type='text' name='mockDeviceName' onChange={updateField} value={state.mockDeviceName || ''} />
                            </div>
                        </div>
                        <div className='m-tabbed-panel-footer'>
                            <button title={RESX.modal.add.option1.cta_title} className='btn btn-info' disabled={!state.connectionString || state.connectionString === '' || state.mockDeviceName === ''} onClick={() => clickAddDevice('hub')}>{RESX.modal.add.option1.cta_label}</button>
                        </div>
                    </>}

                    {panel !== 2 ? null : <>
                        <div className='m-tabbed-panel-form'>
                            <div className='form-group'>
                                <label>{RESX.modal.add.option2.label.name}</label>
                                <input className='form-control form-control-sm' type='text' name='mockDeviceName' onChange={updateField} value={state.mockDeviceName || ''} placeholder={RESX.modal.add.option2.label.name_placeholder} />
                            </div>
                            {deviceContext.ui.container ? null : <>
                                <br />
                                <div className='form-group'>
                                    <button className='btn btn-success' onClick={() => loadFromDisk('capabilityModel')}>{RESX.modal.add.option2.label.browse}</button>
                                </div>
                            </>}
                            <div className='form-group' style={{ height: "calc(100% - 160px)" }}>
                                <Json json={state.capabilityModel} cb={(text: any) => { updateJson(text, 'capabilityModel') }} err={() => setError(RESX.modal.error_json)} />
                            </div>

                        </div>
                        <div className='m-tabbed-panel-footer'>
                            <button title={RESX.modal.add.option2.cta_title} className='btn btn-info' onClick={() => clickAddDevice('template')}>{RESX.modal.add.option2.cta_label}</button>
                        </div>
                    </>}

                    {panel !== 3 ? null : <>
                        <div className='m-tabbed-panel-form'>
                            <div className='form-group'>
                                <label>{RESX.modal.add.option2.label.name}</label>
                                <input className='form-control form-control-sm' type='text' name='mockDeviceName' onChange={updateField} value={state.mockDeviceName || ''} />
                            </div>
                        </div>
                        <div className='m-tabbed-panel-footer'>
                            <button title={RESX.modal.add.option2.cta_title} className='btn btn-info' disabled={!state.mockDeviceName || state.mockDeviceName === ''} onClick={() => clickAddDevice('template')}>{RESX.modal.add.option2.cta_label}</button>
                        </div>
                    </>}

                    {panel !== 4 ? null : <>
                        <div className='m-tabbed-panel-form'>
                            <div className='form-group'>
                                <div style={{ height: '250px' }}>
                                    <label>{RESX.modal.add.option3.label.state}</label>
                                    <div>
                                        <span><input type='checkbox' name='merge' checked={merge} onClick={() => setMerge(!merge)} /> {RESX.modal.add.option3.label.merge}</span>
                                        <br /><br />
                                        <button className='btn btn-success' onClick={() => loadFromDisk('machineState')}>{RESX.modal.add.option3.label.browse}</button>
                                    </div>
                                </div>
                                <div>
                                    <label>{RESX.modal.add.option3.label.state_save}</label><br />
                                    <button className='btn btn-danger' onClick={() => saveToDisk()}>{RESX.modal.add.option3.label.browse_folder}</button>
                                </div>
                            </div>
                        </div>
                    </>}

                    {panel !== 5 ? null : <>
                        <div className='m-tabbed-panel-form'>
                            <div className='form-group'><label>{RESX.modal.add.option3.label.copy}</label></div>
                            <div className='form-group' style={{ height: "calc(100% - 60px)" }}>
                                <Json json={state.machineStateClipboard} cb={(text: any) => { updateJson(text, 'machineStateClipboard') }} err={() => setError(RESX.modal.error_json)} />
                            </div>
                        </div>
                        <div className='m-tabbed-panel-footer'>
                            <button title={RESX.modal.add.option3.cta_title} className='btn btn-info' onClick={() => updateCurrentState('machineStateClipboard')}>{RESX.modal.add.option3.cta_label}</button>
                        </div>
                    </>}

                    {panel !== 6 ? null : <>
                        <div className='m-tabbed-panel-form'>
                            <div className='form-group'>
                                <label>{RESX.modal.add.option4.label.deviceId}</label><br />
                                <input autoFocus={true} id="device-id" className='form-control form-control-sm' type='text' name='deviceId' onChange={updateField} value={state.deviceId || ''} />
                            </div>

                            <div className='form-group'>
                                <label>{RESX.modal.add.option4.label.friendly}</label>
                                <input className='form-control form-control-sm' type='text' name='mockDeviceName' onChange={updateField} value={state.mockDeviceName || ''} />
                            </div>
                        </div>
                        <div className='m-tabbed-panel-footer'>
                            <button disabled={state.mockDeviceName === '' || state.deviceId === ''} title={RESX.modal.add.option4.cta_title} className='btn btn-info' onClick={() => clickAddDevice('edge')}>{RESX.modal.add.option4.cta_label}</button>
                        </div>
                    </>}

                </div>
            </div>
        </div >
    </div >
}