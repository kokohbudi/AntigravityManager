import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { getAntigravityExecutablePath, isWsl } from '../../utils/paths';
import { logger } from '../../utils/logger';

const execAsync = promisify(exec);

interface ProcessInfo {
  pid: number;
  name: string;
  cmd: string;
}

/**
 * Gets a list of running Antigravity processes, excluding the current process and the Manager itself.
 */
async function getRunningAntigravityProcesses(): Promise<ProcessInfo[]> {
  const platform = process.platform;
  const currentPid = process.pid;

  try {
    let output = '';
    // Helper to get raw process list string
    const getRawOutput = (): string => {
      if (platform === 'win32') {
        const psCommand = (cmdlet: string) =>
          `powershell -NoProfile -Command "${cmdlet} Win32_Process -Filter \\"Name like 'Antigravity%'\\" | Select-Object ProcessId, Name, CommandLine | ConvertTo-Csv -NoTypeInformation"`;

        try {
          return execSync(psCommand('Get-CimInstance'), {
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 10,
            stdio: ['pipe', 'pipe', 'ignore'],
          });
        } catch (e) {
          // CIM failed (likely older OS), try WMI
          try {
            return execSync(psCommand('Get-WmiObject'), {
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024 * 10,
            });
          } catch (innerE) {
            throw e;
          }
        }
      } else {
        // Unix/Linux/macOS
        // ps -A -o pid,comm,args
        return execSync('ps -A -o pid,comm,args', {
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024 * 10,
        });
      }
    };

    output = getRawOutput();
    const processList: ProcessInfo[] = [];

    if (platform === 'win32') {
      // Parse CSV Output
      const lines = output.trim().split(/\r?\n/);
      // First line is headers "ProcessId","Name","CommandLine"
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        // Regex to match CSV fields: "val1","val2","val3"
        const match = line.match(/^"(\d+)","(.*?)","(.*?)"$/);

        if (match) {
          const pid = parseInt(match[1]);
          const name = match[2];
          const cmdLine = match[3];
          processList.push({ pid, name, cmd: cmdLine || name });
        }
      }
    } else {
      const lines = output.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;

        const pid = parseInt(parts[0]);
        if (isNaN(pid)) continue;
        const rest = parts.slice(1).join(' '); // Comm + Args

        // Basic filtering to reduce noise before detailed check
        if (
          rest.toLowerCase().includes('antigravity')
        ) {
          // On macOS/Linux, parts[1] is comm, rest is full args usually.
          // specifically ps -A -o pid,comm,args means:
          // PID COMMAND ARGS
          // Actually ps output varies. 
          // Let's rely on the fact that 'rest' contains the command line.
          processList.push({ pid, name: parts[1], cmd: rest });
        }
      }
    }

    // Filter the list
    return processList.filter((p) => {
      // Exclude self
      if (p.pid === currentPid) {
        return false;
      }

      const cmdLower = p.cmd.toLowerCase();

      // Exclude this electron app (if named Antigravity Manager explicitly or via path)
      // We check for "Manager" in the command line or path, but be careful not to exclude "Antigravity" if the user put it in a folder "Manager"
      // Safer check: The actual Antigravity app usually doesn't have "Manager" in its process name arguments unless it's a file path argument.
      // But the Manager app definitely has it.
      // Let's stick to the previous logic which seemed to work for exclusion: 
      // "Antigravity Manager" is usually in the name or path of the manager app.
      if (cmdLower.includes('antigravity manager')) {
        return false;
      }

      // Match Antigravity
      // Windows: Antigravity.exe
      // macOS: Antigravity.app or Antigravity binary
      // Linux: Antigravity binary

      if (platform === 'win32') {
        return (
          p.cmd.includes('Antigravity.exe') ||
          (cmdLower.includes('antigravity') && !cmdLower.includes('manager'))
        );
      } else if (platform === 'darwin') {
        // macOS: 
        // 1. .app bundle: /Applications/Antigravity.app
        // 2. dev/binary: .../Antigravity
        return (
          p.cmd.includes('Antigravity.app') ||
          (p.cmd.includes('Antigravity') && !cmdLower.includes('manager'))
        );
      } else {
        // Linux
        return p.cmd.includes('Antigravity') || cmdLower.includes('antigravity');
      }
    });

  } catch (e) {
    logger.error('Failed to list processes', e);
    return [];
  }
}

/**
 * Checks if the Antigravity process is running.
 * @returns {boolean} True if the Antigravity process is running, false otherwise.
 */
export async function isProcessRunning(): Promise<boolean> {
  try {
    const runningProcesses = await getRunningAntigravityProcesses();
    const isRunning = runningProcesses.length > 0;

logger.debug(`isProcessRunning check: ${isRunning} (Found ${runningProcesses.length} processes)`);
    if (isRunning) {
      logger.debug(`Running processes: ${JSON.stringify(runningProcesses.map(p => p.pid + ':' + p.name))}`);
    }
    }

    return isRunning;
  } catch (error) {
    logger.error('Error checking process status:', error);
    return false;
  }
}

/**
 * Closes the Antigravity process.
 * @returns {boolean} True if the Antigravity process is running, false otherwise.
 */
export async function closeAntigravity(): Promise<void> {
  logger.info('Closing Antigravity...');
  const platform = process.platform;

  try {
    // Stage 1: Graceful Shutdown (Platform specific)
    if (platform === 'darwin') {
      // macOS: Use AppleScript to quit gracefully
      try {
        logger.info('Attempting graceful exit via AppleScript...');
        execSync('osascript -e \'tell application "Antigravity" to quit\'', {
          stdio: 'ignore',
          timeout: 3000,
        });
        // Wait for a moment
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch {
        logger.warn('AppleScript exit failed, proceeding to next stage');
      }
    } else if (platform === 'win32') {
      // Windows: Use taskkill /IM (without /F) for graceful close
      try {
        logger.info('Attempting graceful exit via taskkill...');
        // /T = Tree (child processes), /IM = Image Name
        // We do not wait long here.
        execSync('taskkill /IM "Antigravity.exe" /T', {
          stdio: 'ignore',
          timeout: 2000,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch {
        // Ignore failure, we play hard next.
      }
    }

    const targetProcessList = await getRunningAntigravityProcesses();

    if (targetProcessList.length === 0) {
      logger.info('No Antigravity processes found running.');
      return;
    }

    logger.info(`Found ${targetProcessList.length} remaining Antigravity processes. Killing...`);

    for (const p of targetProcessList) {
      try {
        process.kill(p.pid, 'SIGKILL'); // Force kill as final step
      } catch {
        // Ignore if already dead
      }
    }
  } catch (error) {
    logger.error('Error closing Antigravity', error);
    // Fallback to simple kill if everything fails
    try {
      if (platform === 'win32') {
        execSync('taskkill /F /IM "Antigravity.exe" /T', { stdio: 'ignore' });
      } else {
        execSync('pkill -9 -f Antigravity', { stdio: 'ignore' });
      }
    } catch {
      // Ignore
    }
  }
}

/**
 * Waits for the Antigravity process to exit.
 * @param timeoutMs {number} The timeout in milliseconds.
 * @returns {Promise<void>} A promise that resolves when the process exits.
 */
export async function _waitForProcessExit(timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (!(await isProcessRunning())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Process did not exit within timeout');
}

/**
 * Opens a URI protocol.
 * @param uri {string} The URI to open.
 * @returns {Promise<boolean>} True if the URI was opened successfully, false otherwise.
 */
async function openUri(uri: string): Promise<boolean> {
  const platform = process.platform;
  const wsl = isWsl();

  try {
    if (platform === 'darwin') {
      // macOS: use open command
      await execAsync(`open "${uri}"`);
    } else if (platform === 'win32') {
      // Windows: use start command
      await execAsync(`start "" "${uri}"`);
    } else if (wsl) {
      // WSL: use cmd.exe to open URI
      await execAsync(`/mnt/c/Windows/System32/cmd.exe /c start "" "${uri}"`);
    } else {
      // Linux: use xdg-open
      await execAsync(`xdg-open "${uri}"`);
    }
    return true;
  } catch (error) {
    logger.error('Failed to open URI', error);
    return false;
  }
}

/**
 * Starts the Antigravity process.
 * @param useUri {boolean} Whether to use the URI protocol to start Antigravity.
 * @returns {Promise<void>} A promise that resolves when the process starts.
 */
export async function startAntigravity(useUri = true): Promise<void> {
  logger.info('Starting Antigravity...');

  if (await isProcessRunning()) {
    logger.info('Antigravity is already running');
    return;
  }

  if (useUri) {
    logger.info('Using URI protocol to start...');
    const uri = 'antigravity://oauth-success';

    if (await openUri(uri)) {
      logger.info('Antigravity URI launch command sent');
      return;
    } else {
      logger.warn('URI launch failed, trying executable path...');
    }
  }

  // Fallback to executable path
  logger.info('Using executable path to start...');
  const execPath = getAntigravityExecutablePath();

  try {
    if (process.platform === 'darwin') {
      await execAsync(`open -a Antigravity`);
    } else if (process.platform === 'win32') {
      // Use start command to detach
      await execAsync(`start "" "${execPath}"`);
    } else if (isWsl()) {
      // In WSL, convert path and use cmd.exe
      const winPath = execPath
        .replace(/^\/mnt\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`)
        .replace(/\//g, '\\');

      await execAsync(`/mnt/c/Windows/System32/cmd.exe /c start "" "${winPath}"`);
    } else {
      // Linux native
      const child = exec(`"${execPath}"`);
      child.unref();
    }
    logger.info('Antigravity launch command sent');
  } catch (error) {
    logger.error('Failed to start Antigravity via executable', error);
    throw error;
  }
}
