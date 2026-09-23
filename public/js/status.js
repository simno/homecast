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
