import chalk = require("chalk");
import * as child_process from "child_process";
import * as ora from "ora";
import * as os from "os";
import * as util from "util";
import * as which from "which";
import * as workerFarm from "worker-farm";
import { startSpinner } from "./MiscUtils";
const execFile = util.promisify(child_process.execFile);

export async function runAzParallel(argSets: string[][], noParse=false): Promise<any[]> {
  const spinner = startSpinner(chalk`Running {bold ${argSets.length}} az commands on {bold ${Math.min(os.cpus().length, argSets.length)}} threads`);
  const workers = workerFarm({ maxRetries: 0, }, __filename, ["runAzInWorker"]);
  let promises: Promise<any>[] = [];
  for (const args of argSets) {
    promises.push(new Promise((resolve, reject) => {
      workers.runAzInWorker(args, noParse, (retVal: any) => (retVal instanceof Error) ? reject(retVal) : resolve(retVal));
    }));

    // FIXME: Somehow, the az devops extension can fail silently when running too many concurrent threads.
    // See: https://github.com/Azure/azure-devops-cli-extension/issues/1101
    // Hopefully this gets fixed soon, but in the meantime this seems like enough of a delay to avoid that...
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  let result: any[] = [];
  try {
    result = await Promise.all(promises);
    spinner.stop();
  } catch (error) {
    spinner.stop();
    console.error(error.message);
    await new Promise((resolve) => workerFarm.end(workers, resolve));
    process.exit(1);
  }
  workerFarm.end(workers);
  return result;
}

const azPath = which.sync("az");
async function _runAz(args: string[], noParse = false): Promise<any | Error> {
  // This is needed to fix a bunch of issues when using TCC/bash/etc on windows.
  // Basically guarantees that execFile will alway use regular old CMD to spawn az.
  if (process.platform === "win32")
    process.env.COMSPEC = "cmd.exe";

  const options = { windowsVerbatimArguments: true, shell: true } as child_process.ExecFileOptions;
  let azResult: { stdout: string, stderr: string};
  try {
    azResult = await execFile(`"${azPath}"`, args, options);
  } catch (error) {
    return error;
  }
  const stderr = azResult.stderr.toString().trim();
  const azOutput = azResult.stdout.toString();
  try {
    const val = noParse || JSON.parse(azOutput);
    if (stderr)
      console.error(chalk.yellow(stderr))
    return val;
  } catch (error) {
    return new Error(chalk`{yellow ${stderr}}\n{dim ${azOutput}}\n{red ERROR: az did not return valid JSON!}`);
  }
}

export async function runAzCommand(args: string[], noParse=false): Promise<any> {
  const res = await _runAz(args, noParse);
  if (res instanceof Error) {
    console.error(res.message);
    process.exit(1);
  }
  return res;
}

export async function runAzInWorker(args: string[], noParse: boolean, callback: (v: any) => void): Promise<any> {
  callback(await _runAz(args, noParse));
}