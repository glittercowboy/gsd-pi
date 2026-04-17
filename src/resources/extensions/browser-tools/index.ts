/** browser-tools — pi extension: full browser interaction via Playwright. */
import { type ExtensionAPI } from "@gsd/pi-coding-agent";
import { importExtensionModule } from "@gsd/agent-core";

let registrationPromise: Promise<void> | null = null;

async function registerBrowserTools(pi: ExtensionAPI): Promise<void> {
  if (!registrationPromise) {
    registrationPromise = (async () => {
      const [
        lifecycle,
        capture,
        settle,
        refs,
        utils,
        navigation,
        screenshot,
        interaction,
        inspection,
        session,
        assertions,
        refTools,
        wait,
        pages,
        forms,
        intent,
        pdf,
        statePersistence,
        networkMock,
        device,
        extract,
        visualDiff,
        zoom,
        codegen,
        actionCache,
        injectionDetection,
        verify,
      ] = await Promise.all([
        importExtensionModule<typeof import("./lifecycle.js")>(import.meta.url, "./lifecycle.js"),
        importExtensionModule<typeof import("./capture.js")>(import.meta.url, "./capture.js"),
        importExtensionModule<typeof import("./settle.js")>(import.meta.url, "./settle.js"),
        importExtensionModule<typeof import("./refs.js")>(import.meta.url, "./refs.js"),
        importExtensionModule<typeof import("./utils.js")>(import.meta.url, "./utils.js"),
        importExtensionModule<typeof import("./tools/navigation.js")>(import.meta.url, "./tools/navigation.js"),
        importExtensionModule<typeof import("./tools/screenshot.js")>(import.meta.url, "./tools/screenshot.js"),
        importExtensionModule<typeof import("./tools/interaction.js")>(import.meta.url, "./tools/interaction.js"),
        importExtensionModule<typeof import("./tools/inspection.js")>(import.meta.url, "./tools/inspection.js"),
        importExtensionModule<typeof import("./tools/session.js")>(import.meta.url, "./tools/session.js"),
        importExtensionModule<typeof import("./tools/assertions.js")>(import.meta.url, "./tools/assertions.js"),
        importExtensionModule<typeof import("./tools/refs.js")>(import.meta.url, "./tools/refs.js"),
        importExtensionModule<typeof import("./tools/wait.js")>(import.meta.url, "./tools/wait.js"),
        importExtensionModule<typeof import("./tools/pages.js")>(import.meta.url, "./tools/pages.js"),
        importExtensionModule<typeof import("./tools/forms.js")>(import.meta.url, "./tools/forms.js"),
        importExtensionModule<typeof import("./tools/intent.js")>(import.meta.url, "./tools/intent.js"),
        importExtensionModule<typeof import("./tools/pdf.js")>(import.meta.url, "./tools/pdf.js"),
        importExtensionModule<typeof import("./tools/state-persistence.js")>(import.meta.url, "./tools/state-persistence.js"),
        importExtensionModule<typeof import("./tools/network-mock.js")>(import.meta.url, "./tools/network-mock.js"),
        importExtensionModule<typeof import("./tools/device.js")>(import.meta.url, "./tools/device.js"),
        importExtensionModule<typeof import("./tools/extract.js")>(import.meta.url, "./tools/extract.js"),
        importExtensionModule<typeof import("./tools/visual-diff.js")>(import.meta.url, "./tools/visual-diff.js"),
        importExtensionModule<typeof import("./tools/zoom.js")>(import.meta.url, "./tools/zoom.js"),
        importExtensionModule<typeof import("./tools/codegen.js")>(import.meta.url, "./tools/codegen.js"),
        importExtensionModule<typeof import("./tools/action-cache.js")>(import.meta.url, "./tools/action-cache.js"),
        importExtensionModule<typeof import("./tools/injection-detect.js")>(import.meta.url, "./tools/injection-detect.js"),
        importExtensionModule<typeof import("./tools/verify.js")>(import.meta.url, "./tools/verify.js"),
      ]);

      const deps = {
        ensureBrowser: lifecycle.ensureBrowser,
        closeBrowser: lifecycle.closeBrowser,
        getActivePage: lifecycle.getActivePage,
        getActiveTarget: lifecycle.getActiveTarget,
        getActivePageOrNull: lifecycle.getActivePageOrNull,
        attachPageListeners: lifecycle.attachPageListeners,
        captureCompactPageState: capture.captureCompactPageState,
        postActionSummary: capture.postActionSummary,
        constrainScreenshot: capture.constrainScreenshot,
        captureErrorScreenshot: capture.captureErrorScreenshot,
        formatCompactStateSummary: utils.formatCompactStateSummary,
        getRecentErrors: utils.getRecentErrors,
        settleAfterActionAdaptive: settle.settleAfterActionAdaptive,
        ensureMutationCounter: settle.ensureMutationCounter,
        buildRefSnapshot: refs.buildRefSnapshot,
        resolveRefTarget: refs.resolveRefTarget,
        parseRef: utils.parseRef,
        formatVersionedRef: utils.formatVersionedRef,
        staleRefGuidance: utils.staleRefGuidance,
        beginTrackedAction: utils.beginTrackedAction,
        finishTrackedAction: utils.finishTrackedAction,
        truncateText: utils.truncateText,
        verificationFromChecks: utils.verificationFromChecks,
        verificationLine: utils.verificationLine,
        collectAssertionState: (page: any, checks: any, target?: any) =>
          utils.collectAssertionState(page, checks, capture.captureCompactPageState, target),
        formatAssertionText: utils.formatAssertionText,
        formatDiffText: utils.formatDiffText,
        getUrlHash: utils.getUrlHash,
        captureClickTargetState: utils.captureClickTargetState,
        readInputLikeValue: utils.readInputLikeValue,
        firstErrorLine: utils.firstErrorLine,
        captureAccessibilityMarkdown: (selector?: string) =>
          utils.captureAccessibilityMarkdown(lifecycle.getActiveTarget(), selector),
        resolveAccessibilityScope: utils.resolveAccessibilityScope,
        getLivePagesSnapshot: utils.createGetLivePagesSnapshot(lifecycle.ensureBrowser),
        getSinceTimestamp: utils.getSinceTimestamp,
        getConsoleEntriesSince: utils.getConsoleEntriesSince,
        getNetworkEntriesSince: utils.getNetworkEntriesSince,
        writeArtifactFile: utils.writeArtifactFile,
        copyArtifactFile: utils.copyArtifactFile,
        ensureSessionArtifactDir: utils.ensureSessionArtifactDir,
        buildSessionArtifactPath: utils.buildSessionArtifactPath,
        getSessionArtifactMetadata: utils.getSessionArtifactMetadata,
        sanitizeArtifactName: utils.sanitizeArtifactName,
        formatArtifactTimestamp: utils.formatArtifactTimestamp,
      };

      navigation.registerNavigationTools(pi, deps);
      screenshot.registerScreenshotTools(pi, deps);
      interaction.registerInteractionTools(pi, deps);
      inspection.registerInspectionTools(pi, deps);
      session.registerSessionTools(pi, deps);
      assertions.registerAssertionTools(pi, deps);
      refTools.registerRefTools(pi, deps);
      wait.registerWaitTools(pi, deps);
      pages.registerPageTools(pi, deps);
      forms.registerFormTools(pi, deps);
      intent.registerIntentTools(pi, deps);
      pdf.registerPdfTools(pi, deps);
      statePersistence.registerStatePersistenceTools(pi, deps);
      networkMock.registerNetworkMockTools(pi, deps);
      device.registerDeviceTools(pi, deps);
      extract.registerExtractTools(pi, deps);
      visualDiff.registerVisualDiffTools(pi, deps);
      zoom.registerZoomTools(pi, deps);
      codegen.registerCodegenTools(pi, deps);
      actionCache.registerActionCacheTools(pi, deps);
      injectionDetection.registerInjectionDetectionTools(pi, deps);
      verify.registerVerifyTools(pi, deps);
    })().catch((error) => {
      registrationPromise = null;
      throw error;
    });
  }

  return registrationPromise;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      void registerBrowserTools(pi).catch((error) => {
        ctx.ui.notify(`browser-tools failed to load: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
      return;
    }

    await registerBrowserTools(pi);
  });

  pi.on("session_shutdown", async () => {
    const { closeBrowser } = await importExtensionModule<typeof import("./lifecycle.js")>(import.meta.url, "./lifecycle.js");
    await closeBrowser();
  });
}
