// The status line under the compose form.
import { statusText, statusSpinner, statusSuccess, statusError } from './dom.js';

// type: 'info' | 'loading' | 'success' | 'error'
export function updateStatus(message, type = 'info') {
    statusText.innerText = message;
    statusSpinner.classList.add('hidden');
    statusSuccess.classList.add('hidden');
    statusError.classList.add('hidden');

    if (type === 'loading') statusSpinner.classList.remove('hidden');
    else if (type === 'success') statusSuccess.classList.remove('hidden');
    else if (type === 'error') statusError.classList.remove('hidden');
}

export function handleStreamRecovery(data) {
    console.log('[Recovery]', data);
    if (data.status === 'attempting') {
        updateStatus(`Recovering stream (attempt ${data.attempt}/${data.maxAttempts})...`, 'loading');
    } else if (data.status === 'success') {
        updateStatus('Stream recovered successfully', 'success');
    } else if (data.status === 'failed') {
        updateStatus(`Recovery attempt ${data.attempt} failed`, 'error');
    } else if (data.status === 'giveup') {
        updateStatus('Stream recovery failed - please restart manually', 'error');
    }
}
