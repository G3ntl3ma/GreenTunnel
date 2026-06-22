import koffi from 'koffi';

export function resetWininetSettings(){
    const wininet = koffi.load('wininet.dll');
    const internetSetOption = wininet.func(
    'bool __stdcall InternetSetOptionW(void *hInternet, uint32 dwOption, void *lpBuffer, uint32 dwBufferLength)'
    );

    const internetOptionSettingsChanged = internetSetOption(null, 39, null, 0);
    const internetOptionRefresh = internetSetOption(null, 37, null, 0);
    const internetOptionProxySettingsChanges = internetSetOption(null, 95, null, 0);

    if(!internetOptionSettingsChanged || !internetOptionRefresh || !internetOptionProxySettingsChanges){
        throw new Error('InternetSetOption failed to refresh WinINet proxy settings');
    }
}