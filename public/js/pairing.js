// AirPlay PIN pairing: the modal that asks for the code the Apple TV shows.
import {
    pinModal, pinTitle, pinDeviceName, pinInput, pinStatus,
    pinSubmitBtn, pinCancelBtn, pinCloseBtn
} from './dom.js';
import { state } from './state.js';
import { apiPost } from './api.js';

const pairing = {
    deviceIp: null,
    onPaired: null // retries the cast that needed pairing
};

// `onPaired` runs after a successful pairing (e.g. to retry the cast).
export function showPinPrompt(ip, deviceName, onPaired = null) {
    pairing.deviceIp = ip;
    pairing.onPaired = onPaired;
    pinDeviceName.textContent = deviceName || ip;
    pinInput.value = '';
    pinInput.disabled = false;
    pinSubmitBtn.disabled = true;
    pinStatus.classList.add('hidden');
    pinTitle.textContent = 'Enter AirPlay PIN';
    pinModal.classList.remove('hidden');
    setTimeout(() => pinInput.focus(), 100);
}

export function hidePinPrompt() {
    pinModal.classList.add('hidden');
    pairing.deviceIp = null;
    pairing.onPaired = null;
}

export function isPinPromptOpen() {
    return !pinModal.classList.contains('hidden');
}

function setPinStatus(message, type) {
    pinStatus.textContent = message;
    pinStatus.className = 'pin-status';
    if (type) pinStatus.classList.add(type);
    pinStatus.classList.remove('hidden');
}

function allowRetry({ keepSubmit }) {
    pinInput.disabled = false;
    pinSubmitBtn.disabled = !keepSubmit;
}

async function submitPin() {
    const ip = pairing.deviceIp;
    const pin = pinInput.value.trim();
    if (!ip || !pin) return;

    pinInput.disabled = true;
    pinSubmitBtn.disabled = true;
    setPinStatus('Pairing with device...', 'loading');

    try {
        const res = await apiPost(`/api/airplay/pair/${encodeURIComponent(ip)}`, { pin });
        const data = await res.json();

        if (data.success) {
            setPinStatus('Pairing successful!', 'success');
            state.pairedDevices.add(ip);
            const onPaired = pairing.onPaired;
            setTimeout(() => {
                hidePinPrompt();
                if (onPaired) onPaired();
            }, onPaired ? 1000 : 1500);
        } else if (data.code === 'WRONG_PIN') {
            setPinStatus('Wrong PIN. Check the number on your Apple TV and try again.', 'error');
            pinInput.value = '';
            allowRetry({ keepSubmit: true });
            pinInput.focus();
        } else {
            setPinStatus('Pairing failed: ' + (data.error || 'Unknown error'), 'error');
            allowRetry({ keepSubmit: false });
        }
    } catch (e) {
        setPinStatus('Network error: ' + e.message, 'error');
        allowRetry({ keepSubmit: false });
    }
}

export function wirePairingControls() {
    pinInput.addEventListener('input', () => {
        pinSubmitBtn.disabled = !(/^\d{4,8}$/.test(pinInput.value.trim()));
    });
    pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !pinSubmitBtn.disabled) submitPin();
        if (e.key === 'Escape') hidePinPrompt();
    });
    pinSubmitBtn.addEventListener('click', submitPin);
    pinCancelBtn.addEventListener('click', hidePinPrompt);
    pinCloseBtn.addEventListener('click', hidePinPrompt);
    pinModal.addEventListener('click', (e) => {
        if (e.target === pinModal) hidePinPrompt();
    });
}
