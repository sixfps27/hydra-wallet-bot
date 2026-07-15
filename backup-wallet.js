const fs=require('fs');const path=require('path');
const origem=path.resolve('hydra-wallet.db');const dir=path.resolve('backups');
if(!fs.existsSync(origem)){console.error('hydra-wallet.db não encontrado');process.exit(1);}fs.mkdirSync(dir,{recursive:true});
const d=new Date();const nome=`hydra-wallet-${d.toISOString().replace(/[:.]/g,'-')}.db`;fs.copyFileSync(origem,path.join(dir,nome));
const arquivos=fs.readdirSync(dir).filter(x=>x.endsWith('.db')).sort().reverse();for(const antigo of arquivos.slice(14))fs.unlinkSync(path.join(dir,antigo));
console.log(`✅ Backup criado: backups/${nome}`);
