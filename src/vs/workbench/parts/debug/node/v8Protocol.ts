/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as stream from 'stream';
import * as nls from 'vs/nls';
import * as paths from 'vs/base/common/paths';
import * as debug from 'vs/workbench/parts/debug/common/debug';
import * as platform from 'vs/base/common/platform';
import * as stdfork from 'vs/base/node/stdFork';
import { Emitter, Event } from 'vs/base/common/event';
import { TPromise } from 'vs/base/common/winjs.base';
import { ExtensionsChannelId } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IOutputService } from 'vs/workbench/parts/output/common/output';

/**
 * Abstract implementation of the low level API for a debug adapter.
 * Missing is how this API communicates with the debug adapter.
 */
export abstract class AbstractDebugAdapter implements debug.IDebugAdapter {

	private sequence: number;
	private pendingRequests: Map<number, (e: DebugProtocol.Response) => void>;
	private requestCallback: (request: DebugProtocol.Request) => void;
	private eventCallback: (request: DebugProtocol.Event) => void;

	protected readonly _onError: Emitter<Error>;
	protected readonly _onExit: Emitter<number>;

	constructor() {
		this.sequence = 1;
		this.pendingRequests = new Map<number, (e: DebugProtocol.Response) => void>();

		this._onError = new Emitter<Error>();
		this._onExit = new Emitter<number>();
	}

	abstract startSession(): TPromise<void>;
	abstract stopSession(): TPromise<void>;

	public dispose(): void {
	}

	abstract sendMessage(message: DebugProtocol.ProtocolMessage): void;

	public get onError(): Event<Error> {
		return this._onError.event;
	}

	public get onExit(): Event<number> {
		return this._onExit.event;
	}

	public onEvent(callback: (event: DebugProtocol.Event) => void) {
		if (this.eventCallback) {
			this._onError.fire(new Error(`attempt to set more than one 'Event' callback`));
		}
		this.eventCallback = callback;
	}

	public onRequest(callback: (request: DebugProtocol.Request) => void) {
		if (this.requestCallback) {
			this._onError.fire(new Error(`attempt to set more than one 'Request' callback`));
		}
		this.requestCallback = callback;
	}

	public sendResponse(response: DebugProtocol.Response): void {
		if (response.seq > 0) {
			this._onError.fire(new Error(`attempt to send more than one response for command ${response.command}`));
		} else {
			this.internalSend('response', response);
		}
	}

	public sendRequest(command: string, args: any, clb: (result: DebugProtocol.Response) => void): void {

		const request: any = {
			command: command
		};
		if (args && Object.keys(args).length > 0) {
			request.arguments = args;
		}

		this.internalSend('request', request);

		if (clb) {
			// store callback for this request
			this.pendingRequests.set(request.seq, clb);
		}
	}

	public acceptMessage(message: DebugProtocol.ProtocolMessage) {
		switch (message.type) {
			case 'event':
				if (this.eventCallback) {
					this.eventCallback(<DebugProtocol.Event>message);
				}
				break;
			case 'request':
				if (this.requestCallback) {
					this.requestCallback(<DebugProtocol.Request>message);
				}
				break;
			case 'response':
				const response = <DebugProtocol.Response>message;
				const clb = this.pendingRequests.get(response.request_seq);
				if (clb) {
					this.pendingRequests.delete(response.request_seq);
					clb(response);
				}
				break;
		}
	}

	private internalSend(typ: 'request' | 'response' | 'event', message: DebugProtocol.ProtocolMessage): void {

		message.type = typ;
		message.seq = this.sequence++;

		this.sendMessage(message);
	}
}

/**
 * An implementation that communicates via two streams with the debug adapter.
 */
export abstract class StreamDebugAdapter extends AbstractDebugAdapter {

	private static readonly TWO_CRLF = '\r\n\r\n';

	private outputStream: stream.Writable;
	private rawData: Buffer;
	private contentLength: number;

	constructor() {
		super();
	}

	public connect(readable: stream.Readable, writable: stream.Writable): void {

		this.outputStream = writable;
		this.rawData = Buffer.allocUnsafe(0);
		this.contentLength = -1;

		readable.on('data', (data: Buffer) => this.handleData(data));

		// readable.on('close', () => {
		// 	this._emitEvent(new Event('close'));
		// });
		// readable.on('error', (error) => {
		// 	this._emitEvent(new Event('error', 'readable error: ' + (error && error.message)));
		// });

		// writable.on('error', (error) => {
		// 	this._emitEvent(new Event('error', 'writable error: ' + (error && error.message)));
		// });
	}

	public sendMessage(message: DebugProtocol.ProtocolMessage): void {

		if (this.outputStream) {
			const json = JSON.stringify(message);
			this.outputStream.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}${StreamDebugAdapter.TWO_CRLF}${json}`, 'utf8');
		}
	}

	private handleData(data: Buffer): void {

		this.rawData = Buffer.concat([this.rawData, data]);

		while (true) {
			if (this.contentLength >= 0) {
				if (this.rawData.length >= this.contentLength) {
					const message = this.rawData.toString('utf8', 0, this.contentLength);
					this.rawData = this.rawData.slice(this.contentLength);
					this.contentLength = -1;
					if (message.length > 0) {
						try {
							this.acceptMessage(<DebugProtocol.ProtocolMessage>JSON.parse(message));
						} catch (e) {
							this._onError.fire(new Error((e.message || e) + '\n' + message));
						}
					}
					continue;	// there may be more complete messages to process
				}
			} else {
				const idx = this.rawData.indexOf(StreamDebugAdapter.TWO_CRLF);
				if (idx !== -1) {
					const header = this.rawData.toString('utf8', 0, idx);
					const lines = header.split('\r\n');
					for (const h of lines) {
						const kvPair = h.split(/: +/);
						if (kvPair[0] === 'Content-Length') {
							this.contentLength = Number(kvPair[1]);
						}
					}
					this.rawData = this.rawData.slice(idx + StreamDebugAdapter.TWO_CRLF.length);
					continue;
				}
			}
			break;
		}
	}
}

/**
 * An implementation that launches the debug adapter as a separate process and communicates via stdin/stdout.
 * Used for launching DA in VS Code ("classic" way) and in EH (new way).
 */
export class LocalDebugAdapter extends StreamDebugAdapter {

	private executable: debug.IAdapterExecutable;
	private serverProcess: cp.ChildProcess;


	static platformAdapterExecutable(adapterInfo: debug.IAdapterExecutableInfo, verifyAgainstFS = false): debug.IAdapterExecutable {

		// if there is a "adapterExecutable" we just use that.
		if (adapterInfo.adapterExecutable) {
			return adapterInfo.adapterExecutable;
		}

		// fall back: figure out the command and args from the information in the package.json

		// what is the platform?
		let platformInfo: debug.IRawEnvAdapter;
		if (platform.isWindows && !process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432')) {
			platformInfo = adapterInfo.winx86;
		} else if (platform.isWindows) {
			platformInfo = adapterInfo.win || adapterInfo.windows;
		} else if (platform.isMacintosh) {
			platformInfo = adapterInfo.osx;
		} else if (platform.isLinux) {
			platformInfo = adapterInfo.linux;
		}
		platformInfo = platformInfo || adapterInfo;

		// these are the relevant attributes
		let program = platformInfo.program || adapterInfo.program;
		const args = platformInfo.args || adapterInfo.args;
		let runtime = platformInfo.runtime || adapterInfo.runtime;
		const runtimeArgs = platformInfo.runtimeArgs || adapterInfo.runtimeArgs;

		// TODO: use platform specific variant
		if (!paths.isAbsolute(program)) {
			program = paths.join(adapterInfo.extensionFolderPath, program);
		}

		if (runtime) {
			if (runtime.indexOf('./') === 0) {	// TODO
				runtime = paths.join(adapterInfo.extensionFolderPath, runtime);
			}
			return {
				command: runtime,
				args: (runtimeArgs || []).concat([program]).concat(args || [])
			};
		} else {
			return {
				command: program,
				args: args || []
			};
		}
	}

	/*
	static verifyAdapterDetails(details: debug.IAdapterExecutable, verifyAgainstFS: boolean): TPromise<debug.IAdapterExecutable> {

		if (details.command) {
			if (verifyAgainstFS) {
				if (path.isAbsolute(details.command)) {
					return new TPromise<IAdapterExecutable>((c, e) => {
						fs.exists(details.command, exists => {
							if (exists) {
								c(details);
							} else {
								e(new Error(nls.localize('debugAdapterBinNotFound', "Debug adapter executable '{0}' does not exist.", details.command)));
							}
						});
					});
				} else {
					// relative path
					if (details.command.indexOf('/') < 0 && details.command.indexOf('\\') < 0) {
						// no separators: command looks like a runtime name like 'node' or 'mono'
						return TPromise.as(details);	// TODO: check that the runtime is available on PATH
					}
				}
			} else {
				return TPromise.as(details);
			}
		}

		return TPromise.wrapError(new Error(nls.localize({ key: 'debugAdapterCannotDetermineExecutable', comment: ['Adapter executable file not found'] },
			"Cannot determine executable for debug adapter '{0}'.", this.type)));
	}
	*/

	constructor(executableInfo: debug.IAdapterExecutableInfo, private outputService?: IOutputService) {
		super();
		this.executable = LocalDebugAdapter.platformAdapterExecutable(executableInfo);
	}

	startSession(): TPromise<void> {
		return new TPromise<void>((c, e) => {
			if (this.executable.command === 'node' /*&& this.outputService*/) {
				if (Array.isArray(this.executable.args) && this.executable.args.length > 0) {
					stdfork.fork(this.executable.args[0], this.executable.args.slice(1), {}, (err, child) => {
						if (err) {
							e(new Error(nls.localize('unableToLaunchDebugAdapter', "Unable to launch debug adapter from '{0}'.", this.executable.args[0])));
						}
						this.serverProcess = child;
						c(null);
					});
				} else {
					e(new Error(nls.localize('unableToLaunchDebugAdapterNoArgs', "Unable to launch debug adapter.")));
				}
			} else {
				this.serverProcess = cp.spawn(this.executable.command, this.executable.args);
				c(null);
			}
		}).then(_ => {
			this.serverProcess.on('error', (err: Error) => this._onError.fire(err));
			this.serverProcess.on('exit', (code: number, signal: string) => this._onExit.fire(code));

			if (this.outputService) {
				const sanitize = (s: string) => s.toString().replace(/\r?\n$/mg, '');
				// this.serverProcess.stdout.on('data', (data: string) => {
				// 	console.log('%c' + sanitize(data), 'background: #ddd; font-style: italic;');
				// });
				this.serverProcess.stderr.on('data', (data: string) => {
					this.outputService.getChannel(ExtensionsChannelId).append(sanitize(data));
				});
			}

			this.connect(this.serverProcess.stdout, this.serverProcess.stdin);
		});
	}

	stopSession(): TPromise<void> {

		// when killing a process in windows its child
		// processes are *not* killed but become root
		// processes. Therefore we use TASKKILL.EXE
		if (platform.isWindows) {
			return new TPromise<void>((c, e) => {
				const killer = cp.exec(`taskkill /F /T /PID ${this.serverProcess.pid}`, function (err, stdout, stderr) {
					if (err) {
						return e(err);
					}
				});
				killer.on('exit', c);
				killer.on('error', e);
			});
		} else {
			this.serverProcess.kill('SIGTERM');
			return TPromise.as(null);
		}
	}
}
