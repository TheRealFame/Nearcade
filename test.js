const url = 'viewer.html?client=1&compat=1&host=p2p%3A%2F%2F12345';
const urlParamsGlobal = new URLSearchParams(url.split('?')[1]);
const hostParam = urlParamsGlobal.get('host') || '';
console.log(hostParam);
console.log(hostParam.startsWith('p2p://'));
