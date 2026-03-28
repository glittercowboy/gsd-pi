export function replaceClipboardImageMarkers(
	text: string,
	clipboardImages: ReadonlyMap<number, string>,
): string {
	let result = text;
	for (const [imageId, filePath] of clipboardImages) {
		result = result.replaceAll(`[image #${imageId}]`, filePath);
	}
	return result;
}
