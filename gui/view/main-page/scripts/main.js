const { ipcRenderer, clipboard } = require('electron');

$(document).ready(function() {
    let isMenuOpen = false;
    let savedProxySettings = null;
    const settingsFieldIds = [
        'setting-ip',
        'setting-port',
        'setting-dns-type',
        'setting-dns-server',
        'setting-dns-ip',
        'setting-dns-port',
        'setting-https-only',
        'setting-system-proxy',
        'setting-tls-record-fragmentation',
    ];

    function setFeedback(message, isError = false) {
        $('#settings-feedback')
            .text(message)
            .css('color', isError ? '#ff7b72' : '#6e7681');
    }

    function collectSettings() {
        return {
            ip: $('#setting-ip').val().trim(),
            port: Number($('#setting-port').val()),
            dns: {
                type: String($('#setting-dns-type').val()),
                server: $('#setting-dns-server').val().trim(),
                ip: $('#setting-dns-ip').val().trim(),
                port: Number($('#setting-dns-port').val()),
            },
            httpsOnly: $('#setting-https-only').is(':checked'),
            systemProxy: $('#setting-system-proxy').is(':checked'),
            tlsRecordFragmentation: $('#setting-tls-record-fragmentation').is(':checked'),
        };
    }

    function applySettingsToForm(settings) {
        if (!settings) {
            return;
        }

        savedProxySettings = settings;

        $('#setting-ip').val(settings.ip);
        $('#setting-port').val(settings.port);
        $('#setting-dns-type').val(settings.dns.type);
        $('#setting-dns-server').val(settings.dns.server);
        $('#setting-dns-ip').val(settings.dns.ip);
        $('#setting-dns-port').val(settings.dns.port);
        $('#setting-https-only').prop('checked', Boolean(settings.httpsOnly));
        $('#setting-system-proxy').prop('checked', Boolean(settings.systemProxy));
        $('#setting-tls-record-fragmentation').prop('checked', Boolean(settings.tlsRecordFragmentation));

        $('#proxy-address').text(`${settings.ip}:${settings.port}`);

        updateDnsFieldVisibility();
    }

    function updateDnsFieldVisibility() {
        const type = String($('#setting-dns-type').val());

        $('.dns-https').toggleClass('hidden', !(type === 'https'));
        $('.dns-unencrypted').toggleClass('hidden', !(type === 'unencrypted'));
    }

    async function revertToSavedSettings() {
        const lastGood = await ipcRenderer.invoke('get-proxy-settings');
        applySettingsToForm(lastGood);
    }

    async function saveSettings() {
        try {
            const updated = await ipcRenderer.invoke('save-proxy-settings', collectSettings());
            applySettingsToForm(updated);
            setFeedback('');
        } catch (error) {
            await revertToSavedSettings();
        }
    }

    function closeSettingsMenu() {
        isMenuOpen = false;
        $('#settings-menu').addClass('hidden');
        $('#settings-menu').attr('aria-hidden', 'true');
    }

    $('#setting-dns-type').on('change', updateDnsFieldVisibility);

    $('#close-button').on('click', () => {
        ipcRenderer.send('close-button');
    });

    $('#on-off-button').on('click', () => {
        ipcRenderer.send('on-off-button');
    });

    $('#settings-button').on('click', async (event) => {
        event.stopPropagation();
        if (isMenuOpen) {
            await saveSettings();
        }
        isMenuOpen = !isMenuOpen;
        $('#settings-menu').toggleClass('hidden', !isMenuOpen);
        $('#settings-menu').attr('aria-hidden', String(!isMenuOpen));
    });

    $('#menu-toggle-power').on('click', () => {
        ipcRenderer.send('on-off-button');
    });

    $('.size-option').on('click', function() {
        const preset = $(this).data('size-preset');
        if (!preset) {
            return;
        }

        $('.size-option').removeClass('active');
        $(this).addClass('active');
        ipcRenderer.send('set-window-size', preset);
    });

    $('#restore-default-settings').on('click', async () => {
        setFeedback('');
        try {
            const restored = await ipcRenderer.invoke('reset-proxy-settings');
            applySettingsToForm(restored);
            setFeedback('Defaults restored.');
        } catch (error) {
            await revertToSavedSettings();
        }
    });

    $('#proxy-address-copy').on('click', () => {
        if (!savedProxySettings) {
            return;
        }

        const address = `${savedProxySettings.ip}:${savedProxySettings.port}`;
        clipboard.writeText(address);

        const $hint = $('.proxy-address-copy-hint');
        $hint.text('Copied!');
        setTimeout(() => $hint.text('Copy'), 1500);
    });

    for (const id of settingsFieldIds) {
        $(`#${id}`).on('keydown', async (event) => {
            if (event.key !== 'Enter') {
                return;
            }

            event.preventDefault();
            await saveSettings();
            closeSettingsMenu();
        });
    }

    $(document).on('click', async (event) => {
        if (!isMenuOpen) {
            return;
        }

        if ($(event.target).closest('#settings-menu, #settings-button').length === 0) {
            await saveSettings();
            closeSettingsMenu();
        }
    });

    ipcRenderer.on('changeStatus', (event, isOn) => {
        if (isOn) {
            $('.toggle').removeClass('off').addClass('on');
            $('#status-off-on').text('is on');
            $('#menu-toggle-power').text('Turn Off');
        } else {
            $('.toggle').removeClass('on').addClass('off');
            $('#status-off-on').text('is off');
            $('#menu-toggle-power').text('Turn On');
        }
    });

    ipcRenderer.invoke('get-proxy-settings')
        .then((settings) => {
            applySettingsToForm(settings);
        })
        .catch((error) => {
            setFeedback(String(error?.message || error), true);
        });

});
