const getBrowserBottomDelta = () => {
  // Firefox displays tooltip at the bottom which obstructs the view.
  // As a workaround ensure extra space from the bottom in the viewport
  // firefox detection (https://stackoverflow.com/a/7000222/2870889).
  if (navigator.userAgent.toLowerCase().indexOf('firefox') >= 0) {
    // Hardcoded height of the tooltip plus some margin
    return 26;
  }
  return 0;
};

// Returns true if scrolling was done.
const scrollToElement = (searchEngine, element) => {
  let topMargin = 0;
  if (searchEngine.getTopMargin) {
    topMargin = searchEngine.getTopMargin(element);
  }
  const bottomMargin = getBrowserBottomDelta();
  const elementBounds = element.getBoundingClientRect();
  const scrollY = window.scrollY;
  // It seems that it's only possible to scroll by
  if (elementBounds.top < topMargin) {
    // scroll element to top
    element.scrollIntoView(true);
    window.scrollBy(0, -topMargin);
  } else if (elementBounds.bottom + bottomMargin > window.innerHeight) {
    // scroll element to bottom
    element.scrollIntoView(false);
    window.scrollBy(0, bottomMargin);
  }
  return Math.abs(window.scrollY - scrollY) > 0.01;
};

class SearchResultsManager {
  constructor(searchEngine, options) {
    this.searchEngine = searchEngine;
    this.options = options;
    this.focusedIndex = 0;
  }

  reloadSearchResults() {
    this.searchResults = this.searchEngine.getSearchResults();
  }

  /**
   * Returns the element to click on upon navigation. The focused element in the
   * document is preferred (if there is one) over the highlighted result. Note
   * that the focused element does not have to be an anchor <a> element.
   *
   * @param {boolean} linkOnly If true the focused element is preferred only
   * when it is a link with "href" attribute.
   * @return {Element}
   */
  getElementToNavigate(linkOnly = false) {
    const focusedElement = document.activeElement;
    if (focusedElement == null) {
      return this.searchResults[this.focusedIndex].anchor;
    }
    const isLink = focusedElement.localName === 'a' &&
        focusedElement.hasAttribute('href');
    if (!linkOnly || isLink) {
      return focusedElement;
    }
  }

  focus(index, scrollToResult = true) {
    if (this.focusedIndex >= 0) {
      const searchResult = this.searchResults[this.focusedIndex];
      // If the current result is outside the viewport and scrolling was
      // requested, only scroll to it, but don't focus on the new result.
      if (scrollToResult && scrollToElement(this.searchEngine,
          searchResult.container)) {
        return;
      }
      const highlighted = searchResult.highlightedElement;
      // Remove highlighting from previous item.
      highlighted.classList.remove(searchResult.highlightClass);
      highlighted.classList.remove('wsn-no-outline');
    }
    const searchResult = this.searchResults[index];
    if (!searchResult) {
      this.focusedIndex = -1;
      return;
    }
    const highlighted = searchResult.highlightedElement;
    // Add the focus outline and caret.
    highlighted.classList.add(searchResult.highlightClass);
    if (this.options.hideOutline || searchResult.anchor !== highlighted) {
      searchResult.anchor.classList.add('wsn-no-outline');
    }
    // We already scroll below, so no need for focus to scroll. The scrolling
    // behavior of `focus` also seems less predictable and caused an issue, see:
    // https://github.com/infokiller/web-search-navigator/issues/35
    searchResult.anchor.focus({preventScroll: true});
    // Ensure whole search result container is visible in the viewport, not only
    // the search result link.
    if (scrollToResult) {
      scrollToElement(this.searchEngine, searchResult.container);
    }
    this.focusedIndex = index;
  }

  focusNext(shouldWrap) {
    if (this.focusedIndex < this.searchResults.length - 1) {
      this.focus(this.focusedIndex + 1);
    } else if (shouldWrap) {
      this.focus(0);
    }
  }

  focusPrevious(shouldWrap) {
    if (this.focusedIndex > 0) {
      this.focus(this.focusedIndex - 1);
    } else if (shouldWrap) {
      this.focus(this.searchResults.length - 1);
    } else {
      window.scrollTo(window.scrollX, 0);
    }
  }
}

class WebSearchNavigator {
  async init() {
    /* eslint-disable-next-line no-undef */
    this.options = new ExtensionOptions();
    await this.options.load();
    /* eslint-disable-next-line no-undef */
    this.searchEngine = await getSearchEngine(this.options.sync.getAll());
    if (this.searchEngine == null) {
      return;
    }
    await sleep(this.options.sync.get('delay'));
    this.injectCSS();
    this.initResultsNavigation();
    this.initSearchInputNavigation();
    this.initTabsNavigation();
    this.initChangeToolsNavigation();
  }

  injectCSS() {
    const style = document.createElement('style');
    style.textContent = this.options.sync.get('customCSS');
    document.head.append(style);
  }

  initSearchInputNavigation() {
    const searchInput = document.querySelector(
        this.searchEngine.searchBoxSelector);
    // Only apply the extension logic if the key is not something the user may
    // have wanted to type into the searchbox, so that we don't interfere with
    // regular typing.
    const shouldHandleSearchInputKey = (event) => {
      return event.ctrlKey || event.metaKey || event.key === 'Escape';
    };
    // If insideSearchboxHandler returns true, outsideSearchboxHandler will also
    // be called (because it's defined on document, hence has lower priority),
    // in which case we don't want to handle the event. Therefore, we store the
    // last event handled in insideSearchboxHandler, and only handle the event
    // in outsideSearchboxHandler if it's not the same one.
    let lastEvent;
    const outsideSearchboxHandler = (event) => {
      if (event === lastEvent) {
        return !shouldHandleSearchInputKey(event);
      }
      // Scroll to the search box in case it's outside the viewport so that it's
      // clear to the user that it has focus.
      scrollToElement(this.searchEngine, searchInput);
      searchInput.select();
      searchInput.click();
      return false;
    };
    const insideSearchboxHandler = (event) => {
      lastEvent = event;
      if (!shouldHandleSearchInputKey(event)) {
        return true;
      }
      // Everything is selected; deselect all.
      if (searchInput.selectionStart === 0 &&
          searchInput.selectionEnd === searchInput.value.length) {
        // Scroll to the search box in case it's outside the viewport so that
        // it's clear to the user that it has focus.
        scrollToElement(this.searchEngine, searchInput);
        searchInput.setSelectionRange(
            searchInput.value.length, searchInput.value.length);
        return false;
      }
      // Closing search suggestions via document.body.click() or
      // searchInput.blur() breaks the state of google's controller.
      // The suggestion box is closed, yet it won't re-appear on the next
      // search box focus event.

      // Input can be blurred only when the suggestion box is already
      // closed, hence the blur event is queued.
      window.setTimeout(() => searchInput.blur());
      // Invoke the default handler which will close-up search suggestions
      // properly (google's controller won't break), but it won't remove the
      // focus.
      return true;
    };
    this.register(this.options.sync.get('focusSearchInput'),
        outsideSearchboxHandler);
    // Bind globally, otherwise Mousetrap ignores keypresses inside inputs.
    // We must bind it separately to the search box element, or otherwise the
    // key event won't always be captured (for example this is the case on
    // Google Search as of 2020-06-22), presumably because the javascript in the
    // page will disable further processing.
    this.registerGlobal(this.options.sync.get('focusSearchInput'),
        insideSearchboxHandler, searchInput);
  }

  initTabsNavigation() {
    const tabs = this.searchEngine.tabs || {};
    for (const [optionName, element] of Object.entries(tabs)) {
      this.register(this.options.sync.get(optionName), () => {
        if (element == null) {
          return true;
        }
        // Some search engines use forms instead of links for navigation
        if (element.tagName == 'FORM') {
          element.submit();
        } else {
          element.click();
        }
      });
    }
  }

  initResultsNavigation() {
    this.resetResultsManager();
    this.registerResultsNavigationKeybindings();
    if (!this.searchEngine.onChangedResults) {
      return;
    }
    this.searchEngine.onChangedResults((appendedOnly) => {
      if (appendedOnly) {
        this.resultsManager.reloadSearchResults();
      } else {
        this.resetResultsManager();
      }
    });
  }

  resetResultsManager() {
    this.resultsManager = new SearchResultsManager(this.searchEngine,
        this.options.sync.getAll());
    this.resultsManager.reloadSearchResults();
    if (this.resultsManager.searchResults.length === 0) {
      return;
    }
    this.isFirstNavigation = true;
    if (this.options.sync.get('autoSelectFirst')) {
      // Highlight the first result when the page is loaded, but don't scroll to
      // it because there may be KP cards such as stock graphs.
      this.resultsManager.focus(0, false);
    }
    const lastNavigation = this.options.local.values;
    if (location.href === lastNavigation.lastQueryUrl) {
      this.isFirstNavigation = false;
      this.resultsManager.focus(lastNavigation.lastFocusedIndex);
    }
  }

  registerResultsNavigationKeybindings() {
    const getOpt = (key) => {
      return this.options.sync.get(key);
    };
    this.register(getOpt('nextKey'), () => {
      if (!getOpt('autoSelectFirst') && this.isFirstNavigation) {
        this.resultsManager.focus(0);
        this.isFirstNavigation = false;
      } else {
        this.resultsManager.focusNext(getOpt('wrapNavigation'));
      }
      return false;
    });
    this.register(getOpt('previousKey'), () => {
      if (!getOpt('autoSelectFirst') && this.isFirstNavigation) {
        this.resultsManager.focus(0);
        this.isFirstNavigation = false;
      } else {
        this.resultsManager.focusPrevious(getOpt('wrapNavigation'));
      }
      return false;
    });
    this.register(getOpt('navigateKey'), () => {
      const link = this.resultsManager.getElementToNavigate();
      const lastNavigation = this.options.local.values;
      lastNavigation.lastQueryUrl = location.href;
      lastNavigation.lastFocusedIndex = this.resultsManager.focusedIndex;
      this.options.local.save();
      link.click();
      return false;
    });
    this.register(getOpt('navigateNewTabKey'), () => {
      const link = this.resultsManager.getElementToNavigate(true);
      /* eslint-disable-next-line no-undef */
      browser.runtime.sendMessage({
        type: 'tabsCreate',
        options: {
          url: link.href,
          active: true,
        },
      });
      return false;
    });
    this.register(getOpt('navigateNewTabBackgroundKey'), () => {
      const link = this.resultsManager.getElementToNavigate(true);
      /* eslint-disable-next-line no-undef */
      browser.runtime.sendMessage({
        type: 'tabsCreate',
        options: {
          url: link.href,
          active: false,
        },
      });
      return false;
    });
  }

  initChangeToolsNavigation() {
    const getOpt = (key) => {
      return this.options.sync.get(key);
    };
    this.register(getOpt('navigateShowAll'), () =>
      this.searchEngine.changeTools('a'));
    this.register(getOpt('navigateShowHour'), () =>
      this.searchEngine.changeTools('h'));
    this.register(getOpt('navigateShowDay'), () =>
      this.searchEngine.changeTools('d'));
    this.register(getOpt('navigateShowWeek'), () =>
      this.searchEngine.changeTools('w'));
    this.register(getOpt('navigateShowMonth'), () =>
      this.searchEngine.changeTools('m'));
    this.register(getOpt('navigateShowYear'), () =>
      this.searchEngine.changeTools('y'));
    this.register(getOpt('toggleVerbatimSearch'), () =>
      this.searchEngine.changeTools('v'));
    this.register(getOpt('toggleSort'), () =>
      this.searchEngine.changeTools(null));
  }

  registerGlobal(shortcut, callback, element = document) {
    /* eslint-disable-next-line no-undef,new-cap */
    Mousetrap(element).bindGlobal(shortcut, (event) => {
      return callback(event);
    });
  }

  register(shortcut, callback, element = document) {
    /* eslint-disable-next-line no-undef,new-cap */
    Mousetrap(element).bind(shortcut, (event) => {
      return callback(event);
    });
  }
}

/**
 * Make functions sleeps
 *
 * Can be used with then() callback :
 * sleep.then(() => { stuff to do after sleeps }),
 * Or in an async function, like we do below extension initialization
 * @param {*} milliseconds, How long you want your function to sleep
 * @return {Promise} a Promise resolving a timeout
 */
const sleep = (milliseconds) => {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const extension = new WebSearchNavigator();
extension.init();
