<script lang="ts">
	let {
		documentId,
		mimeType,
		originalFilename
	}: { documentId: string; mimeType: string; originalFilename: string } = $props();

	const isPdf = $derived(mimeType === 'application/pdf');
	const fileUrl = $derived(`/documents/${documentId}/file`);

	let zoom = $state(1);
	let offsetX = $state(0);
	let offsetY = $state(0);
	let dragging = false;
	let lastX = 0;
	let lastY = 0;

	function clampZoom(value: number): number {
		return Math.min(6, Math.max(0.5, value));
	}

	function zoomIn() {
		zoom = clampZoom(zoom * 1.25);
	}

	function zoomOut() {
		zoom = clampZoom(zoom / 1.25);
	}

	function resetView() {
		zoom = 1;
		offsetX = 0;
		offsetY = 0;
	}

	function onWheel(event: WheelEvent) {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		zoom = clampZoom(zoom * (event.deltaY < 0 ? 1.1 : 0.9));
	}

	function onPointerDown(event: PointerEvent) {
		dragging = true;
		lastX = event.clientX;
		lastY = event.clientY;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onPointerMove(event: PointerEvent) {
		if (!dragging) return;
		offsetX += event.clientX - lastX;
		offsetY += event.clientY - lastY;
		lastX = event.clientX;
		lastY = event.clientY;
	}

	function onPointerUp() {
		dragging = false;
	}
</script>

<div class="flex h-full min-h-[24rem] flex-col border-2 border-ink bg-white">
	<div class="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink px-3 py-2">
		<p class="min-w-0 truncate font-mono text-xs font-bold uppercase" title={originalFilename}>
			{originalFilename}
		</p>
		{#if !isPdf}
			<div class="flex items-center gap-1">
				<button
					type="button"
					class="border border-ink px-2 py-0.5 font-mono text-xs font-bold hover:bg-ink hover:text-paper"
					onclick={zoomOut}
					aria-label="Zoom out">−</button
				>
				<span class="w-12 text-center font-mono text-xs">{Math.round(zoom * 100)}%</span>
				<button
					type="button"
					class="border border-ink px-2 py-0.5 font-mono text-xs font-bold hover:bg-ink hover:text-paper"
					onclick={zoomIn}
					aria-label="Zoom in">+</button
				>
				<button
					type="button"
					class="border border-ink px-2 py-0.5 font-mono text-xs font-bold hover:bg-ink hover:text-paper"
					onclick={resetView}>Reset</button
				>
			</div>
		{/if}
	</div>
	<div class="relative flex-1 overflow-hidden bg-ink/10">
		{#if isPdf}
			<iframe
				src={fileUrl}
				title={`PDF preview of ${originalFilename}`}
				class="h-full min-h-[24rem] w-full"
			>
			</iframe>
			<p class="px-3 py-2 font-mono text-[11px] text-ink/50">
				Use the embedded viewer's controls for multipage navigation and zoom.
			</p>
		{:else}
			<div
				class="h-full min-h-[22rem] w-full cursor-grab touch-none select-none active:cursor-grabbing"
				role="application"
				aria-label={`Zoom and pan controls for ${originalFilename}`}
				onwheel={onWheel}
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerUp}
			>
				<img
					src={fileUrl}
					alt={`Receipt image ${originalFilename}`}
					class="max-h-none max-w-none origin-top-left object-contain"
					style={`transform: translate(${offsetX}px, ${offsetY}px) scale(${zoom}); width: 100%;`}
					draggable="false"
				/>
			</div>
		{/if}
	</div>
</div>
