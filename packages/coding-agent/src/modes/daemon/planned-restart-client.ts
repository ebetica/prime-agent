import { DaemonClient } from "./daemon-client.js";
import type { DaemonPlannedRestartHandoff, DaemonPlannedRestartLifecycleResult } from "./daemon-protocol.js";

export interface RegisterDaemonPlannedRestartHandoffOptions {
	socketPath: string;
	requestId: string;
	activeSessionId: string;
	workerToken: string;
	message: string;
}

export async function registerDaemonPlannedRestartHandoff(
	options: RegisterDaemonPlannedRestartHandoffOptions,
): Promise<DaemonPlannedRestartHandoff> {
	const client = new DaemonClient(options.socketPath);
	try {
		await client.connect();
		await client.waitForHello();
		const response = await client.request(
			{
				type: "register_planned_restart_handoff",
				requestId: options.requestId,
				activeSessionId: options.activeSessionId,
				workerToken: options.workerToken,
				message: options.message,
			},
			30_000,
		);
		if (!response.success) throw new Error(response.error);
		return response.data as DaemonPlannedRestartHandoff;
	} finally {
		client.close();
	}
}

export interface CancelDaemonPlannedRestartHandoffOptions {
	socketPath: string;
	requestId: string;
	activeSessionId: string;
	workerToken: string;
}

export async function cancelDaemonPlannedRestartHandoff(
	options: CancelDaemonPlannedRestartHandoffOptions,
): Promise<DaemonPlannedRestartLifecycleResult> {
	const client = new DaemonClient(options.socketPath);
	try {
		await client.connect();
		await client.waitForHello();
		const response = await client.request(
			{
				type: "cancel_planned_restart_handoff",
				requestId: options.requestId,
				activeSessionId: options.activeSessionId,
				workerToken: options.workerToken,
			},
			30_000,
		);
		if (!response.success) throw new Error(response.error);
		return response.data as DaemonPlannedRestartLifecycleResult;
	} finally {
		client.close();
	}
}

export interface AcknowledgeDaemonPlannedRestartHandoffOptions {
	socketPath: string;
	requestId: string;
	acknowledgementToken: string;
}

export async function acknowledgeDaemonPlannedRestartHandoff(
	options: AcknowledgeDaemonPlannedRestartHandoffOptions,
): Promise<DaemonPlannedRestartLifecycleResult> {
	const client = new DaemonClient(options.socketPath);
	try {
		await client.connect();
		await client.waitForHello();
		const response = await client.request(
			{
				type: "acknowledge_planned_restart_handoff",
				requestId: options.requestId,
				acknowledgementToken: options.acknowledgementToken,
			},
			30_000,
		);
		if (!response.success) throw new Error(response.error);
		return response.data as DaemonPlannedRestartLifecycleResult;
	} finally {
		client.close();
	}
}
