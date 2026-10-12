const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const target=path.join(root,'dist');
if(path.dirname(target)!==root||path.basename(target)!=='dist')throw new Error('Generated build directory validation failed.');
fs.rmSync(target,{recursive:true,force:true});
