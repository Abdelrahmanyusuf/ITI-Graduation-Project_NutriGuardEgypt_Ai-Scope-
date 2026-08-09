import { backupPostgres, restorePostgres } from "../ops/postgres.js";
import { createQdrantSnapshot, recoverQdrantSnapshot } from "../ops/qdrant.js";
import { smokeTest } from "../ops/deployment.js";
const [command,...args]=process.argv.slice(2);
if(command==="postgres-backup"){console.log(JSON.stringify({sha256:await backupPostgres(args[0]??"")}));}
else if(command==="postgres-restore"){await restorePostgres(args[0]??"",args[1]??"");console.log("restore completed");}
else if(command==="qdrant-snapshot"){console.log(JSON.stringify(await createQdrantSnapshot({baseUrl:process.env.QDRANT_URL??"",collection:process.env.QDRANT_COLLECTION??"",apiKey:process.env.QDRANT_API_KEY,target:process.env.DEPLOYMENT_TARGET as "staging"|"production"})));}
else if(command==="qdrant-recover"){console.log(JSON.stringify(await recoverQdrantSnapshot({baseUrl:process.env.QDRANT_URL??"",collection:process.env.QDRANT_COLLECTION??"",apiKey:process.env.QDRANT_API_KEY,target:process.env.DEPLOYMENT_TARGET as "staging"|"production"},args[0]??"",args[1]??"")));}
else if(command==="smoke"){const result=await smokeTest(args[0]??"",args[1]??"");console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}
else throw new Error("command must be postgres-backup, postgres-restore, qdrant-snapshot, qdrant-recover, or smoke");
