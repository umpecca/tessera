//go:build darwin && desktop && cgo

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

static NSString *const BundleID = @"io.github.umpecca.tessera.desktop";
static NSString *const FocusNotification = @"io.github.umpecca.tessera.desktop.focus";

@interface TesseraApplication : NSObject <NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate>
@property(strong) NSWindow *window;
@property(strong) WKWebView *webView;
@property(strong) NSURL *origin;
@property(copy) NSString *token;
@property(strong) NSMapTable<WKDownload *, NSDictionary *> *downloads;
@property BOOL closing;
@property BOOL ready;
@property NSUInteger closeAttempt;
- (void)beginClose;
- (void)finishClose;
- (void)showError:(NSString *)message;
@end

static TesseraApplication *application;

static void Alert(NSString *message) {
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Tessera Desktop";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert runModal];
}

@implementation TesseraApplication
- (BOOL)isLocal:(NSURL *)url {
    return [url.scheme isEqualToString:self.origin.scheme] &&
        [url.host isEqualToString:self.origin.host] &&
        [url.port isEqualToNumber:self.origin.port];
}

- (BOOL)isWorkspace:(NSURL *)url {
    return [self isLocal:url] && (url.path.length == 0 || [url.path isEqualToString:@"/"]);
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSMenu *menu = [NSMenu new];
    NSMenuItem *appItem = [NSMenuItem new];
    NSMenu *appMenu = [NSMenu new];
    [appMenu addItemWithTitle:@"About Tessera Desktop" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Hide Tessera Desktop" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItemWithTitle:@"Quit Tessera Desktop" action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = appMenu;
    [menu addItem:appItem];
    NSMenuItem *editItem = [NSMenuItem new];
    NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
    [edit addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
    NSMenuItem *redo = [edit addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"z"];
    redo.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    [edit addItem:[NSMenuItem separatorItem]];
    [edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    editItem.submenu = edit;
    [menu addItem:editItem];
    NSMenuItem *windowItem = [NSMenuItem new];
    NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
    [windowMenu addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [windowMenu addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
    [windowMenu addItemWithTitle:@"Close" action:@selector(performClose:) keyEquivalent:@"w"];
    windowItem.submenu = windowMenu;
    [menu addItem:windowItem];
    NSApp.mainMenu = menu;
    NSApp.windowsMenu = windowMenu;

    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1200, 800)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
            NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"Tessera Desktop";
    self.window.minSize = NSMakeSize(640, 480);
    self.window.delegate = self;
    self.window.releasedWhenClosed = NO;
    [self.window center];
    [self.window setFrameAutosaveName:@"TesseraDesktopWindow"];

    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    // A bundled application's default store is separate from Safari and the
    // server's browsers. The saved local port keeps localStorage stable.
    config.websiteDataStore = [WKWebsiteDataStore defaultDataStore];
    config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    [config.userContentController addScriptMessageHandler:self name:@"tesseraLifecycle"];
    WKUserScript *script = [[WKUserScript alloc] initWithSource:
        @"Object.defineProperty(window, '__tesseraDesktop', {value: true});"
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
    [config.userContentController addUserScript:script];
    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;
    self.downloads = [NSMapTable strongToStrongObjectsMapTable];
    self.window.contentView = self.webView;
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [[NSDistributedNotificationCenter defaultCenter] addObserver:self
        selector:@selector(focus:) name:FocusNotification object:nil];

    // Cookies have no port boundary. Prevent every off-origin network request,
    // including requests from sandboxed panes, before provisioning the secret.
    // Browser panes reach local sites through Tessera's existing cookie-stripping
    // proxy. An external top-level link is handled by the system browser.
    NSString *port = self.origin.port.stringValue;
    NSArray *rules = @[
        @{@"trigger": @{@"url-filter": @".*"}, @"action": @{@"type": @"block"}},
        @{@"trigger": @{@"url-filter": [NSString stringWithFormat:@"^http://127\\.0\\.0\\.1:%@/", port]},
          @"action": @{@"type": @"ignore-previous-rules"}},
        @{@"trigger": @{@"url-filter": [NSString stringWithFormat:@"^ws://127\\.0\\.0\\.1:%@/", port]},
          @"action": @{@"type": @"ignore-previous-rules"}},
        @{@"trigger": @{@"url-filter": @"^data:"}, @"action": @{@"type": @"ignore-previous-rules"}},
        @{@"trigger": @{@"url-filter": @"^blob:"}, @"action": @{@"type": @"ignore-previous-rules"}}
    ];
    NSData *json = [NSJSONSerialization dataWithJSONObject:rules options:0 error:nil];
    NSString *source = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    [[WKContentRuleListStore defaultStore] compileContentRuleListForIdentifier:@"TesseraLocalOnly"
        encodedContentRuleList:source completionHandler:^(WKContentRuleList *list, NSError *error) {
        if (error || !list) {
            [self showError:@"Could not install the local-only webview policy. The workspace was not opened."];
            [self finishClose];
            return;
        }
        [config.userContentController addContentRuleList:list];
        NSString *header = [NSString stringWithFormat:@"tessera_desktop=%@; Path=/; HttpOnly", self.token];
        NSHTTPCookie *cookie = [NSHTTPCookie cookiesWithResponseHeaderFields:@{@"Set-Cookie": header}
            forURL:self.origin].firstObject;
        if (!cookie || ![cookie isHTTPOnly]) {
            [self showError:@"Could not initialize the private desktop session."];
            [self finishClose];
            return;
        }
        [config.websiteDataStore.httpCookieStore setCookie:cookie completionHandler:^{
            [self.webView loadRequest:[NSURLRequest requestWithURL:self.origin]];
            self.token = nil;
        }];
    }];
}

- (void)focus:(NSNotification *)notification {
    [self.window deminiaturize:nil];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible {
    [self focus:nil];
    return YES;
}

- (void)showError:(NSString *)message { Alert(message); }

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    [self beginClose];
    return NSTerminateCancel;
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
    [self beginClose];
    return NO;
}

- (void)finishClose {
    self.closing = YES;
    self.closeAttempt++;
    [self.webView stopLoading];
    [self.webView.configuration.userContentController removeScriptMessageHandlerForName:@"tesseraLifecycle"];
    [self.window orderOut:nil];
    [NSApp stop:nil];
    // Wake run so Go can close PTYs/audio/storage before the process exits.
    [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined
        location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil
        subtype:0 data1:0 data2:0] atStart:NO];
}

- (void)offerForcedClose:(NSString *)message {
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"The workspace has not finished saving";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"Keep Open"];
    [alert addButtonWithTitle:@"Quit Without Saving"];
    if ([alert runModal] == NSAlertSecondButtonReturn) [self finishClose];
    else self.closing = NO;
}

- (void)beginClose {
    if (self.closing) return;
    self.closing = YES;
    if (!self.ready) {
        [self offerForcedClose:@"The application is still loading or unavailable. Quitting stops all managed terminals and commands."];
        return;
    }
    NSUInteger attempt = ++self.closeAttempt;
    [self.webView evaluateJavaScript:@"window.dispatchEvent(new Event('tessera:native-close'))"
        completionHandler:^(id result, NSError *error) {
        if (error && self.closing && self.closeAttempt == attempt) {
            self.closeAttempt++;
            [self offerForcedClose:@"The workspace could not respond to the save request."];
        }
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (self.closing && self.closeAttempt == attempt) {
            self.closeAttempt++;
            [self offerForcedClose:@"Saving took longer than expected. Quitting now may lose recent workspace changes."];
        }
    });
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    // No privileged bridge is available to Browser panes or other origins.
    if (!message.frameInfo.mainFrame || ![self isWorkspace:message.frameInfo.request.URL] ||
        ![message.body isKindOfClass:[NSString class]]) return;
    NSString *body = message.body;
    if ([body isEqualToString:@"ready"]) self.ready = YES;
    else if ([body isEqualToString:@"saved"] && self.closing) [self finishClose];
    else if ([body isEqualToString:@"cancel"] && self.closing) {
        self.closing = NO;
        self.closeAttempt++;
    } else if ([body isEqualToString:@"save-failed"] && self.closing) {
        self.closeAttempt++;
        [self offerForcedClose:@"The workspace could not be saved. Keep it open to resolve the connection or save conflict."];
    }
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    BOOL main = action.targetFrame == nil || action.targetFrame.mainFrame;
    if (main) {
        if ([self isWorkspace:url]) {
            decisionHandler(WKNavigationActionPolicyAllow);
        } else if (([self isLocal:url] && [url.path isEqualToString:@"/api/files/download"]) ||
            (action.shouldPerformDownload && [self isWorkspace:action.sourceFrame.request.URL] &&
             [url.absoluteString hasPrefix:[@"blob:" stringByAppendingString:self.origin.absoluteString]])) {
            decisionHandler(WKNavigationActionPolicyDownload);
        } else {
            if (([url.scheme isEqualToString:@"https"] || [url.scheme isEqualToString:@"http"]) &&
                ![self isLocal:url] && action.navigationType == WKNavigationTypeLinkActivated && action.sourceFrame.mainFrame) {
                [[NSWorkspace sharedWorkspace] openURL:url];
            }
            decisionHandler(WKNavigationActionPolicyCancel);
        }
        return;
    }
    BOOL proxy = [self isLocal:url] && [url.path hasPrefix:@"/browser-proxy/"];
    decisionHandler(proxy || [url.absoluteString isEqualToString:@"about:blank"]
        ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)config
    forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    // New native webviews must never inherit the credential or bridge.
    if ([self isWorkspace:action.request.URL]) [self focus:nil];
    return nil;
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationResponse:(WKNavigationResponse *)response
    decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
    if (!response.canShowMIMEType && [self isLocal:response.response.URL]) {
        decisionHandler(WKNavigationResponsePolicyDownload);
    } else decisionHandler(WKNavigationResponsePolicyAllow);
}

- (void)webView:(WKWebView *)webView navigationAction:(WKNavigationAction *)action didBecomeDownload:(WKDownload *)download {
    download.delegate = self;
}
- (void)webView:(WKWebView *)webView navigationResponse:(WKNavigationResponse *)response didBecomeDownload:(WKDownload *)download {
    download.delegate = self;
}
- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
    suggestedFilename:(NSString *)filename completionHandler:(void (^)(NSURL *))completionHandler {
    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.nameFieldStringValue = filename.lastPathComponent;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        if (result != NSModalResponseOK) { completionHandler(nil); return; }
        NSURL *temporary = [panel.URL.URLByDeletingLastPathComponent URLByAppendingPathComponent:
            [NSString stringWithFormat:@".tessera-%@.download", NSUUID.UUID.UUIDString]];
        [self.downloads setObject:@{@"temporary": temporary, @"destination": panel.URL} forKey:download];
        completionHandler(temporary);
    }];
}
- (void)downloadDidFinish:(WKDownload *)download {
    NSDictionary *paths = [self.downloads objectForKey:download];
    if (!paths) return;
    NSURL *temporary = paths[@"temporary"], *destination = paths[@"destination"];
    NSFileManager *files = NSFileManager.defaultManager;
    NSError *error = nil;
    if ([files fileExistsAtPath:destination.path]) {
        [files replaceItemAtURL:destination withItemAtURL:temporary backupItemName:nil options:0 resultingItemURL:nil error:&error];
    } else {
        [files moveItemAtURL:temporary toURL:destination error:&error];
    }
    [self.downloads removeObjectForKey:download];
    if (error) [self showError:[NSString stringWithFormat:@"Could not save the download. The completed file remains at %@.", temporary.path]];
}
- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
    NSDictionary *paths = [self.downloads objectForKey:download];
    if (paths) {
        [[NSFileManager defaultManager] removeItemAtURL:paths[@"temporary"] error:nil];
        [self.downloads removeObjectForKey:download];
    }
    if (error.code != NSURLErrorCancelled) [self showError:@"The file download failed. Please try again."];
}
- (void)download:(WKDownload *)download willPerformHTTPRedirection:(NSHTTPURLResponse *)response
    newRequest:(NSURLRequest *)request decisionHandler:(void (^)(WKDownloadRedirectPolicy))decisionHandler {
    decisionHandler([self isLocal:request.URL] ? WKDownloadRedirectPolicyAllow : WKDownloadRedirectPolicyCancel);
}

- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))completionHandler {
    if (!frame.mainFrame || ![self isWorkspace:frame.request.URL]) { completionHandler(nil); return; }
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
    panel.canChooseDirectories = parameters.allowsDirectories;
    panel.canChooseFiles = YES;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        completionHandler(result == NSModalResponseOK ? panel.URLs : nil);
    }];
}
- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    if (frame.mainFrame && [self isWorkspace:frame.request.URL]) Alert(message);
    completionHandler();
}
- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    if (!frame.mainFrame || ![self isWorkspace:frame.request.URL]) { completionHandler(NO); return; }
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Tessera Desktop";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert addButtonWithTitle:@"Cancel"];
    completionHandler([alert runModal] == NSAlertFirstButtonReturn);
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (error.code != NSURLErrorCancelled) [self showError:@"The local workspace could not be loaded. Quit and reopen Tessera Desktop."];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    self.ready = NO;
    [self showError:@"The webview stopped. Tessera will reload the last saved workspace; managed terminals are still running."];
    [webView reload];
}
@end

void tesseraRun(const char *url, const char *token) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        application = [TesseraApplication new];
        application.origin = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
        application.token = [NSString stringWithUTF8String:token];
        NSApp.delegate = application;
        [NSApp run];
        [[NSDistributedNotificationCenter defaultCenter] removeObserver:application];
        application = nil;
    }
}
void tesseraError(const char *message) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp activateIgnoringOtherApps:YES];
        Alert([NSString stringWithUTF8String:message]);
    }
}
void tesseraFocus(void) {
    @autoreleasepool {
        for (NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:BundleID]) {
            if (app.processIdentifier != NSProcessInfo.processInfo.processIdentifier)
                [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        }
        [[NSDistributedNotificationCenter defaultCenter] postNotificationName:FocusNotification object:nil
            userInfo:nil deliverImmediately:YES];
    }
}
void tesseraRequestClose(const char *message) {
    NSString *text = [NSString stringWithUTF8String:message];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (text.length) [application showError:text];
        [application beginClose];
    });
}
