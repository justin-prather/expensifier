import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { requirePermission } from '$lib/server/authorization';
import { DocumentRepository } from '$lib/server/documents';
import { FileLifecycleService } from '$lib/server/files';
import { appRuntime } from '$lib/server/runtime';
import { error } from '@sveltejs/kit';
import { Effect } from 'effect';

import type { RequestHandler } from './$types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ locals, params }) => {
	requirePermission(locals.user, 'expenses:view');
	if (!UUID_PATTERN.test(params.id)) error(404, 'Document not found');

	const document = await appRuntime.runPromise(
		DocumentRepository.use((repository) => repository.findById(params.id))
	);
	if (!document || document.status !== 'processing') error(404, 'Document not found');

	const filePath = await appRuntime.runPromise(
		FileLifecycleService.use((service) => Effect.sync(() => service.absolutePath(document)))
	);
	const metadata = await stat(filePath).catch(() => null);
	if (!metadata?.isFile()) error(404, 'Document not found');

	const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
	return new Response(stream, {
		headers: {
			'Content-Type': document.mimeType,
			'Content-Length': String(metadata.size),
			'Content-Disposition': `inline; filename="${document.originalFilename.replace(/["\\]/g, '_')}"`,
			'Cache-Control': 'private, no-store'
		}
	});
};
