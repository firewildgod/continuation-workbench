const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const root=path.resolve(__dirname,'..');
  const svg=fs.readFileSync(path.join(root,'assets/app-icon.svg'),'utf8');
  const window=new BrowserWindow({show:false,width:256,height:256,transparent:true,webPreferences:{offscreen:true}});
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html><body style="margin:0;background:transparent">'+svg+'</body></html>'));
  const png=(await window.webContents.capturePage({x:0,y:0,width:256,height:256})).toPNG();
  fs.writeFileSync(path.join(root,'assets/app-icon.png'),png);
  const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);
  header[6]=0;header[7]=0;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);
  header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
  fs.writeFileSync(path.join(root,'assets/app-icon.ico'),Buffer.concat([header,png]));
  console.log('Native vector brand icon rendered to PNG and ICO.');window.destroy();app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
