import QtQuick
import QtQuick.Controls as QQC
import Quickshell
import qs.Commons
import qs.Ui
import "lib/settings.mjs" as Settings
import "lib/settingspage.mjs" as PageLib
import "lib/holdings.mjs" as Holdings
import "lib/format.mjs" as Format
import "lib/cash.mjs" as Cash

// The panel's settings page, opened from the gear. Every change saves at once:
// settings to the widget's shell.json entry, holdings to portfolio.json through
// MarketService. Sections:
// - General: base currency, whether asset prices show in their own currency
//   (nativePrices), refresh interval (60 s minimum; a lower typed value snaps
//   back on blur with a note saying why) and the range the panel opens on.
// - Bar rotation: rotation interval and the rotation list (drag to reorder, ✕).
// - Holdings: quantity and average cost edited in place, the cost currency
//   changed with ▾, 󰐕 toggling bar membership, ✕ removing; a search adds one.
//   Read-only, with the reason, while portfolio.json cannot be read.
// - Watchlist: the same search adding to `watch`.
// - Data: where prices come from, the holdings path and "Open folder".
//
// Holds only what is being typed; every value shown comes from the shared
// MarketService. Each page is created when the gear opens it and destroyed when
// it closes, so a half-typed search never greets the next visit.
//
// The panel reads `editing` to step its key catcher aside while a field or a
// popup owns the keyboard.
FocusScope {
  id: page

  // The Panel.qml that shows this page; its market, settings and bar are used.
  property var panel: null

  readonly property var market: panel ? panel.market : null
  readonly property var config: market ? market.config : Settings.DEFAULTS
  readonly property var holdings: market ? market.holdings : []
  readonly property var quotes: market ? market.quotes : ({})
  readonly property string base: config.baseCurrency
  // Holdings cannot be changed: the file is unreadable, or there is no service.
  readonly property bool locked: !market || market.holdingsError !== ""

  readonly property bool editing: activeFocus || currencyPicker.popupOpen || rangePicker.popupOpen || costMenu.opened

  readonly property color fg: panel ? panel.fg : Color.popups.text
  readonly property color dim: Color.muted
  readonly property string fontFamily: panel ? panel.fontFamily : Style.font.family

  implicitHeight: column.implicitHeight

  // ---- Saving

  // Writes `patch` into the widget's settings entry: locally first, so the
  // control moves on the click and the service sees it at once, then to
  // shell.json through the shell (Omacoins' persistSettings pattern).
  function persist(patch) {
    if (!panel) return
    var entry = PageLib.settingsEntry(panel.moduleName, panel.settings, patch)
    panel.settings = entry
    if (panel.hostWidget && "settings" in panel.hostWidget) panel.hostWidget.settings = entry
    if (panel.bar && panel.bar.shell && typeof panel.bar.shell.updateEntryInline === "function")
      panel.bar.shell.updateEntryInline(panel.moduleName, entry)
  }

  // The asset's listing currency once its quote has said it; null before
  // then, and for crypto, which is not listed anywhere (its quotes are in US
  // dollars only because CoinGecko is asked in them), so its cost currency is
  // always stored.
  function listingOf(asset) {
    var quote = quotes[asset]
    return quote && asset.indexOf("crypto:") !== 0 ? quote.currency : null
  }

  // The currency a holding's cost is in, as the portfolio values it: its own
  // costCurrency, else its quote's currency (US dollars for crypto); null
  // before a quote has said it. For display and comparison only: an edit
  // still stores a crypto holding's currency explicitly (listingOf).
  function costCurrencyOf(holding) {
    if (holding.costCurrency) return holding.costCurrency
    var quote = quotes[holding.asset]
    return quote ? quote.currency : null
  }

  // Saves exactly `list`. Only user actions call this; nothing on the page
  // writes portfolio.json on its own.
  function saveHoldings(list) {
    return !locked && market.saveHoldings(list)
  }

  // Changes the holding with `identity` ({asset, costCurrency}); nothing when
  // no holding has it any more. A costCurrency equal to the asset's listing
  // currency is dropped from this holding only (lib/holdings.mjs editHolding).
  function editHolding(identity, changes) {
    if (!identity) return
    var next = Holdings.editHolding(holdings, identity.asset, identity.costCurrency, changes, listingOf(identity.asset))
    if (next !== holdings) saveHoldings(next)
  }

  // Structural changes first let a field still being edited save into its own
  // row: losing the keyboard finishes the edit.
  function setCostCurrency(holding, chosen) {
    unfocus()
    // Picking the currency it is already in changes nothing.
    if (!holding || chosen === costCurrencyOf(holding)) return
    editHolding(holding, { costCurrency: chosen })
  }

  function removeHolding(holding) {
    unfocus()
    if (holding) saveHoldings(Holdings.withoutHolding(holdings, holding.asset, holding.costCurrency))
  }

  // Adds a searched asset as a holding (or finds the one already held) and puts
  // the cursor in its quantity field. Cash starts at the current rate, so at no
  // gain; anything else at a cost of 0.
  function addHolding(result) {
    unfocus()
    var cost = Cash.isCash(result.asset) ? Cash.startingCost(result.asset, quotes, base) : 0
    var added = Holdings.addHolding(holdings, result.asset, base, cost)
    if (added.added && !saveHoldings(added.holdings)) return
    holdingSearch.clear()
    // Adding a row rebuilds the rows; focus the new one once that is done.
    Qt.callLater(function() {
      var row = holdingRows.itemAt(added.index)
      if (row) row.focusQuantity()
    })
  }

  function inBar(item) {
    return config.bar.indexOf(item) >= 0
  }

  function toggleBar(item) {
    persist({ bar: PageLib.toggleItem(config.bar, item) })
  }

  // ---- Keyboard

  function unfocus() {
    if (panel) panel.releaseFocus()
  }

  // Keys the fields leave alone: Enter and Esc finish an edit.
  Keys.onReturnPressed: unfocus()
  Keys.onEnterPressed: unfocus()
  Keys.onEscapePressed: unfocus()

  // A click on bare page takes the keyboard back from whichever field had it.
  MouseArea {
    anchors.fill: parent
    onClicked: page.unfocus()
  }

  // The search box that asked the service last; only it shows results.
  property var searchOwner: null

  Component.onDestruction: if (searchOwner && market) market.search("")

  // ---- Building blocks

  readonly property int rowHeight: Style.space(28)
  readonly property int gap: Style.space(8)

  component Caption: Text {
    textFormat: Text.PlainText
    color: page.dim
    font.family: page.fontFamily
    font.pixelSize: Style.font.bodySmall
    wrapMode: Text.Wrap
  }

  component Label: Text {
    textFormat: Text.PlainText
    color: page.fg
    font.family: page.fontFamily
    font.pixelSize: Style.font.body
    elide: Text.ElideRight
  }

  component SectionTitle: PanelSectionHeader {
    width: parent ? parent.width : 0
    topPadding: Style.space(14)
    bottomPadding: Style.space(4)
    foreground: page.fg
    fontFamily: page.fontFamily
    font.letterSpacing: 1
  }

  // A label on the left and a control on the right.
  component SettingRow: Item {
    property string label: ""
    default property alias control: slot.data

    width: parent ? parent.width : 0
    implicitHeight: Math.max(page.rowHeight, slot.childrenRect.height) + Style.space(6)

    Label {
      anchors.left: parent.left
      anchors.right: slot.left
      anchors.rightMargin: page.gap
      anchors.verticalCenter: parent.verticalCenter
      text: parent.label
    }

    Item {
      id: slot
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      width: childrenRect.width
      height: childrenRect.height
    }
  }

  // Whole seconds from `min` to `max`. The ▴▾ stepper and the arrow keys save at
  // once; a typed value is saved when the field loses the keyboard, raised to
  // `min` or lowered to `max` when outside them, and `committed` says whether
  // it was raised. Esc puts the stored value back.
  component SecondsField: Row {
    id: seconds
    property int min: 1
    property int max: 86400
    property int current: min
    signal committed(int value, bool snapped)

    spacing: Style.space(6)

    function shown() { return Number(current).toLocaleString(Qt.locale(), "f", 0) }

    // Whether typing has changed the text since the stored value was shown.
    property bool edited: false

    function show() {
      field.text = shown()
      edited = false
    }

    onCurrentChanged: if (!edited) show()
    Component.onCompleted: show()

    // Saves what was typed, if anything, and shows the stored value.
    function finish() {
      var typed = edited ? PageLib.snapSeconds(field.text, min, max) : null
      show()
      if (typed) committed(typed.seconds, typed.snapped)
    }

    // One step from the typed value, or from the stored one when nothing
    // valid was typed.
    function stepBy(delta) {
      var typed = edited ? PageLib.snapSeconds(field.text, min, max) : null
      var next = Math.max(min, Math.min(max, (typed ? typed.seconds : current) + delta))
      show()
      if (next !== current) committed(next, false)
    }

    KeyField {
      id: field
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(72)
      allowed: /[0-9,]/
      foreground: page.fg
      font.family: page.fontFamily
      font.pixelSize: Style.font.body
      horizontalAlignment: Text.AlignRight
      // As tall as the dropdowns in the neighbouring rows.
      verticalPadding: Style.space(5)
      rightPadding: horizontalPadding + Border.right(borderSpec) + stepper.width + Style.space(4)
      onTextEdited: seconds.edited = true
      onEditingFinished: seconds.finish()

      Keys.onUpPressed: seconds.stepBy(1)
      Keys.onDownPressed: seconds.stepBy(-1)
      Keys.onEscapePressed: {
        seconds.show()
        page.unfocus()
      }

      Column {
        id: stepper
        anchors.right: parent.right
        anchors.rightMargin: field.horizontalPadding + Border.right(field.borderSpec) - Style.space(2)
        anchors.verticalCenter: parent.verticalCenter

        Repeater {
          model: [{ glyph: "▴", delta: 1 }, { glyph: "▾", delta: -1 }]

          Text {
            required property var modelData
            textFormat: Text.PlainText
            text: modelData.glyph
            color: arrowMouse.containsMouse ? page.fg : page.dim
            font.family: page.fontFamily
            font.pixelSize: Style.font.caption
            height: Style.space(9)
            verticalAlignment: Text.AlignVCenter

            MouseArea {
              id: arrowMouse
              anchors.fill: parent
              anchors.margins: -Style.space(2)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: seconds.stepBy(parent.modelData.delta)
            }
          }
        }
      }
    }

    Text {
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: "s"
      color: page.dim
      font.family: page.fontFamily
      font.pixelSize: Style.font.body
    }
  }

  // A quantity or cost of `holding`, saved on Enter or blur. Only an edit
  // saves: text left as it was shown writes nothing, so a value with more
  // decimals than shown is never rounded by a visit. Text that is not a number
  // puts the stored value back; Esc does too. `prefix` is drawn inside the
  // field before the number, and `menu` adds a ▾ that asks for a menu.
  //
  // Rows follow the list by position, so the holding behind a row can change
  // under an edit (a removal, a reorder of the file). The edit belongs to the
  // holding the field had when it took the keyboard: `commit` hands back that
  // identity ({asset, costCurrency}), and the page saves into it or nowhere.
  component AmountField: KeyField {
    id: amount
    property var holding: null
    property real current: 0
    property string prefix: ""
    property bool menu: false
    signal commit(var identity, real value)
    signal menuRequested()

    // Set when the field takes the keyboard: whose value is being edited, and
    // the text it showed then.
    property var editing: null
    property string shownText: ""

    function stored() { return Format.formatQuantity(current) }

    onActiveFocusChanged: {
      if (!activeFocus) return
      editing = holding ? { asset: holding.asset, costCurrency: holding.costCurrency } : null
      shownText = text
    }

    function finish() {
      var value = text !== shownText ? PageLib.parseAmount(text) : null
      if (editing && value !== null) commit(editing, value)
      text = stored()
      shownText = text
      if (!activeFocus) editing = null
    }

    readOnly: page.locked
    allowed: /[0-9.,]/
    foreground: page.fg
    font.family: page.fontFamily
    font.pixelSize: Style.font.body
    horizontalAlignment: Text.AlignRight
    verticalPadding: Style.space(3)
    horizontalPadding: Style.space(6)
    leftPadding: horizontalPadding + Border.left(borderSpec) + (prefixText.visible ? prefixText.implicitWidth + Style.space(2) : 0)
    rightPadding: horizontalPadding + Border.right(borderSpec) + (chevron.visible ? chevron.implicitWidth + Style.space(4) : 0)
    text: stored()
    // Typing breaks the `text` binding; a value saved from elsewhere is
    // pushed in by hand unless the user is mid-edit.
    onCurrentChanged: if (!activeFocus) text = stored()
    onEditingFinished: finish()

    Keys.onPressed: function(event) {
      if (event.key === Qt.Key_Escape) {
        editing = null
        text = stored()
        page.unfocus()
        event.accepted = true
      } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
        finish()
        page.unfocus()
        event.accepted = true
      }
    }

    Text {
      id: prefixText
      visible: amount.prefix !== ""
      anchors.left: parent.left
      anchors.leftMargin: amount.horizontalPadding + Border.left(amount.borderSpec)
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: amount.prefix
      color: page.dim
      font: amount.font
    }

    Text {
      id: chevron
      visible: amount.menu
      anchors.right: parent.right
      anchors.rightMargin: amount.horizontalPadding + Border.right(amount.borderSpec)
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: "▾"
      color: chevronHover.containsMouse ? page.fg : page.dim
      font: amount.font

      MouseArea {
        id: chevronHover
        anchors.fill: parent
        anchors.margins: -Style.space(4)
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: amount.menuRequested()
      }
    }
  }

  // 󰐕: adds `item` to the bar rotation, or takes it out; accent while in it.
  component BarToggle: PanelActionButton {
    property string item: ""
    readonly property bool active: page.inBar(item)
    size: Style.space(20)
    fontSize: Style.font.body
    iconText: "󰐕"
    tooltipText: active ? "In the bar rotation; click to remove" : "Add to the bar rotation"
    foreground: active ? Color.accent : page.dim
    hoverColor: Color.accent
    fontFamily: page.fontFamily
    onClicked: page.toggleBar(item)
  }

  component RemoveButton: PanelActionButton {
    size: Style.space(20)
    fontSize: Style.font.body
    iconText: "✕"
    tooltipText: "Remove"
    foreground: page.dim
    hoverColor: Color.urgent
    fontFamily: page.fontFamily
  }

  // One search box across Yahoo and CoinGecko, debounced 300 ms. Up/Down move
  // the highlight, Enter (or a click) picks, Esc clears. The service runs one
  // search at a time, so only the box that asked last shows its results.
  component SearchBox: Column {
    id: box
    property string placeholderText: ""
    signal picked(var result)

    readonly property string query: input.text.trim()
    readonly property bool fresh: page.searchOwner === box && page.market !== null
      && page.market.searchQuery === query && query !== ""
    readonly property var results: fresh ? page.market.searchResults : []
    property int cursor: 0

    function clear() {
      input.text = ""
      debounce.stop()
      cursor = 0
      if (page.searchOwner === box && page.market) page.market.search("")
    }

    function pick(i) {
      if (i >= 0 && i < results.length) picked(results[i])
    }

    width: parent ? parent.width : 0
    spacing: 0

    onResultsChanged: cursor = Math.min(cursor, Math.max(0, results.length - 1))

    KeyField {
      id: input
      width: parent.width
      placeholderText: box.placeholderText
      foreground: page.fg
      font.family: page.fontFamily
      font.pixelSize: Style.font.body
      verticalPadding: Style.space(5)

      onTextEdited: {
        box.cursor = 0
        debounce.restart()
      }

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) {
          box.clear()
          page.unfocus()
          event.accepted = true
        } else if (event.key === Qt.Key_Down) {
          box.cursor = Math.min(box.results.length - 1, box.cursor + 1)
          resultList.positionViewAtIndex(box.cursor, ListView.Contain)
          event.accepted = true
        } else if (event.key === Qt.Key_Up) {
          box.cursor = Math.max(0, box.cursor - 1)
          resultList.positionViewAtIndex(box.cursor, ListView.Contain)
          event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
          box.pick(box.cursor)
          event.accepted = true
        }
      }
    }

    Timer {
      id: debounce
      interval: 300
      onTriggered: {
        if (!page.market) return
        page.searchOwner = box
        page.market.search(input.text)
      }
    }

    Caption {
      width: parent.width
      topPadding: Style.space(4)
      visible: box.query !== "" && box.results.length === 0
      text: !box.fresh || page.market.searching ? "Searching…" : "No matches"
      font.italic: true
    }

    ListView {
      id: resultList
      width: parent.width
      height: Math.min(count, 5) * page.resultHeight
      visible: count > 0
      clip: true
      interactive: count > 5
      boundsBehavior: Flickable.StopAtBounds
      model: box.results

      delegate: Rectangle {
        id: result
        required property var modelData
        required property int index
        readonly property bool current: box.cursor === index
        width: resultList.width
        height: page.resultHeight
        radius: Style.cornerRadius
        color: current ? Style.hoverFillFor(page.fg, Color.accent) : "transparent"

        Column {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(8)
          anchors.right: exchange.left
          anchors.rightMargin: page.gap
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(1)

          Row {
            spacing: Style.space(6)

            Label {
              text: result.modelData.symbol
              color: result.modelData.kind === "crypto" ? Color.accent : page.fg
            }

            Rectangle {
              readonly property string label: PageLib.kindLabel(result.modelData.kind)
              visible: label !== ""
              anchors.verticalCenter: parent.verticalCenter
              width: badgeText.implicitWidth + Style.space(8)
              height: badgeText.implicitHeight + Style.space(2)
              radius: Style.cornerRadius
              color: Style.selectedFillFor(page.fg, Color.accent)

              Text {
                id: badgeText
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: parent.label
                color: result.modelData.kind === "crypto" ? Color.accent : page.fg
                font.family: page.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          Caption {
            width: parent.width
            text: result.modelData.name
            wrapMode: Text.NoWrap
            elide: Text.ElideRight
          }
        }

        Caption {
          id: exchange
          anchors.right: parent.right
          anchors.rightMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          width: Math.min(implicitWidth, parent.width / 3)
          text: result.modelData.exchange
          wrapMode: Text.NoWrap
          elide: Text.ElideRight
        }

        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onPositionChanged: box.cursor = result.index
          onClicked: box.pick(result.index)
        }
      }
    }
  }

  readonly property int resultHeight: Style.space(38)

  // Cost-currency choices for one holding, under its cost field.
  QQC.Popup {
    id: costMenu
    // {holding, current} of the row that opened it; `current` is the
    // currency its cost is in now (page.costCurrencyOf), or null.
    property var target: null
    readonly property var options: {
      if (!target) return []
      var current = target.current
      return current && Settings.CURRENCIES.indexOf(current) < 0 ? [current].concat(Settings.CURRENCIES) : Settings.CURRENCIES
    }
    readonly property string selected: target ? (target.current || "") : ""

    function openFor(field, holding, current) {
      target = { holding: holding, current: current }
      parent = field
      x = field.width - width
      y = field.height + Style.space(2)
      open()
    }

    width: Style.space(84)
    height: Math.min(options.length, 8) * Style.spacing.popupRowHeight + 2 * padding
    padding: Style.space(1)
    focus: true
    onOpened: {
      menuList.currentIndex = Math.max(0, options.indexOf(selected))
      menuList.positionViewAtIndex(menuList.currentIndex, ListView.Center)
      menuList.forceActiveFocus()
    }
    onClosed: target = null

    function choose(code) {
      if (target) page.setCostCurrency(target.holding, code)
      close()
    }

    background: Rectangle {
      color: Color.popups.background
      border.color: Color.popups.border
      border.width: Style.normalBorderWidth
      radius: Style.cornerRadius
    }

    contentItem: ListView {
      id: menuList
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      model: costMenu.options

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) { costMenu.close(); event.accepted = true }
        else if (event.key === Qt.Key_Down || event.text === "j") { incrementCurrentIndex(); event.accepted = true }
        else if (event.key === Qt.Key_Up || event.text === "k") { decrementCurrentIndex(); event.accepted = true }
        else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
          costMenu.choose(costMenu.options[currentIndex])
          event.accepted = true
        }
      }

      delegate: Rectangle {
        required property string modelData
        required property int index
        width: menuList.width
        height: Style.spacing.popupRowHeight
        color: index === menuList.currentIndex ? Style.hoverFillFor(page.fg, Color.accent) : "transparent"

        Label {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          text: parent.modelData
          color: parent.modelData === costMenu.selected ? Color.accent : page.fg
        }

        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onPositionChanged: menuList.currentIndex = parent.index
          onClicked: costMenu.choose(parent.modelData)
        }
      }
    }
  }

  // ---- The page

  Column {
    id: column
    width: parent.width
    spacing: 0

    // ---- General
    SectionTitle { text: "GENERAL"; topPadding: Style.space(2) }

    Repeater {
      model: page.market ? page.market.settingsNotes : []

      Caption {
        required property string modelData
        width: column.width
        bottomPadding: Style.space(4)
        text: modelData
      }
    }

    SettingRow {
      label: "Base currency"

      Dropdown {
        id: currencyPicker
        width: Style.space(88)
        showLabel: false
        options: Settings.CURRENCIES
        value: page.base
        foreground: page.fg
        fontFamily: page.fontFamily
        onChanged: function(v) {
          page.persist({ baseCurrency: v })
          value = Qt.binding(function() { return page.base })
          page.unfocus()
        }
      }
    }

    // Clicking anywhere on the row flips the switch; Space or Enter does too
    // once Tab has reached it.
    Item {
      id: nativeRow
      width: column.width
      implicitHeight: Math.max(page.rowHeight, nativeLabel.implicitHeight) + Style.space(6)
      activeFocusOnTab: true

      function flip() { page.persist({ nativePrices: !page.config.nativePrices }) }

      Keys.onSpacePressed: flip()
      Keys.onReturnPressed: flip()
      Keys.onEnterPressed: flip()

      Text {
        id: nativeLabel
        anchors.left: parent.left
        anchors.right: nativeSwitch.left
        anchors.rightMargin: page.gap
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: "Show prices in each asset's own currency"
        color: page.fg
        font.family: page.fontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.Wrap
      }

      ToggleSwitch {
        id: nativeSwitch
        anchors.right: parent.right
        // The cursor ring's padding sits outside the track's edge, so the
        // track lines up with the controls above and below.
        anchors.rightMargin: -cursorPad
        anchors.verticalCenter: parent.verticalCenter
        checked: page.config.nativePrices
        interactive: false
        hasCursor: nativeRow.activeFocus || nativeMouse.containsMouse
        cursorRing: true
        foreground: page.fg
      }

      MouseArea {
        id: nativeMouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: nativeRow.flip()
      }
    }

    Caption {
      width: column.width
      bottomPadding: Style.space(4)
      text: "Totals, values and gains stay in " + page.base + "."
    }

    SettingRow {
      label: "Refresh every"

      SecondsField {
        min: Settings.MIN_REFRESH_SECONDS
        current: page.config.refreshSeconds
        onCommitted: function(value, snapped) {
          page.refreshSnapped = snapped
          page.persist({ refreshSeconds: value })
        }
      }
    }

    Caption {
      width: column.width
      bottomPadding: Style.space(4)
      visible: page.refreshSnapped
      text: Settings.REFRESH_MIN_NOTE
    }

    SettingRow {
      label: "Chart range on open"

      Dropdown {
        id: rangePicker
        width: Style.space(88)
        showLabel: false
        options: Settings.RANGES
        value: page.config.range
        foreground: page.fg
        fontFamily: page.fontFamily
        onChanged: function(v) {
          page.persist({ range: v })
          value = Qt.binding(function() { return page.config.range })
          page.unfocus()
        }
      }
    }

    // ---- Bar rotation
    SectionTitle { text: "BAR ROTATION" }

    SettingRow {
      label: "Rotate every"

      SecondsField {
        min: Settings.MIN_ROTATE_SECONDS
        max: 3600
        current: page.config.rotateSeconds
        onCommitted: function(value, snapped) { page.persist({ rotateSeconds: value }) }
      }
    }

    Repeater {
      id: barRows
      model: page.config.bar

      // A row of the rotation list. Dragging the grip moves the row; dropping
      // it moves the item to the slot under it.
      Item {
        id: barRow
        required property string modelData
        required property int index
        width: column.width
        height: page.rowHeight
        z: grip.drag.active ? 2 : 0

        Rectangle {
          id: barRowBody
          width: parent.width
          height: parent.height
          radius: Style.cornerRadius
          // Opaque while dragged, so it covers the rows it passes over.
          color: grip.drag.active ? Color.popups.background : "transparent"

          Rectangle {
            anchors.fill: parent
            visible: grip.drag.active
            radius: Style.cornerRadius
            color: Style.hoverFillFor(page.fg, Color.accent)
          }

          Text {
            id: gripGlyph
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(16)
            textFormat: Text.PlainText
            text: "⠿"
            color: grip.containsMouse || grip.drag.active ? page.fg : page.dim
            font.family: page.fontFamily
            font.pixelSize: Style.font.body
          }

          Label {
            anchors.left: gripGlyph.right
            anchors.leftMargin: page.gap
            anchors.right: barKind.left
            anchors.rightMargin: page.gap
            anchors.verticalCenter: parent.verticalCenter
            readonly property var quote: page.quotes[barRow.modelData]
            text: PageLib.itemLabel(barRow.modelData, quote)
            color: barRow.modelData.indexOf("crypto:") === 0 ? Color.accent : page.fg
          }

          Caption {
            id: barKind
            anchors.right: barRemove.left
            anchors.rightMargin: Style.space(4)
            anchors.verticalCenter: parent.verticalCenter
            wrapMode: Text.NoWrap
            readonly property var quote: page.quotes[barRow.modelData]
            text: quote ? PageLib.kindLabel(quote.kind) : ""
          }

          // The bar always shows something, so its last item stays.
          RemoveButton {
            id: barRemove
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            visible: page.config.bar.length > 1
            tooltipText: "Remove from the bar"
            onClicked: page.persist({ bar: PageLib.withoutItem(page.config.bar, barRow.modelData) })
          }

          MouseArea {
            id: grip
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: Style.space(24)
            hoverEnabled: true
            cursorShape: drag.active ? Qt.ClosedHandCursor : Qt.OpenHandCursor
            preventStealing: true
            drag.target: barRowBody
            drag.axis: Drag.YAxis
            drag.minimumY: -barRow.index * page.rowHeight
            drag.maximumY: (barRows.count - 1 - barRow.index) * page.rowHeight
            onReleased: {
              var to = barRow.index + Math.round(barRowBody.y / page.rowHeight)
              var from = barRow.index
              barRowBody.y = 0
              if (to !== from) page.persist({ bar: PageLib.moveItem(page.config.bar, from, to) })
            }
          }
        }

        PanelSeparator {
          anchors.bottom: parent.bottom
          foreground: page.fg
          strength: 0.06
        }
      }
    }

    Caption {
      width: column.width
      topPadding: Style.space(6)
      text: "Drag ⠿ to reorder. Add holdings and watched assets with their 󰐕 below."
    }

    // ---- Holdings
    SectionTitle { text: "HOLDINGS" }

    Caption {
      width: column.width
      bottomPadding: Style.space(6)
      visible: page.market !== null && page.market.holdingsError !== ""
      text: page.market ? page.market.holdingsError + ". Fix the file to edit holdings here." : ""
      color: page.fg
    }

    Caption {
      width: column.width
      bottomPadding: Style.space(6)
      visible: page.market !== null && page.market.holdingsNote !== ""
      text: page.market ? page.market.holdingsNote : ""
    }

    // The portfolio total has no row of its own, so its bar toggle lives here.
    Item {
      width: column.width
      height: page.rowHeight
      visible: page.holdings.length > 0

      Row {
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(4)

        Label {
          anchors.verticalCenter: parent.verticalCenter
          text: PageLib.itemLabel(PageLib.PORTFOLIO_ITEM, null)
        }

        BarToggle {
          anchors.verticalCenter: parent.verticalCenter
          item: PageLib.PORTFOLIO_ITEM
        }
      }
    }

    // Column headings.
    Item {
      width: column.width
      height: headingAsset.implicitHeight + Style.space(4)
      visible: page.holdings.length > 0

      Caption {
        id: headingAsset
        anchors.left: parent.left
        text: "Asset"
        font.pixelSize: Style.font.caption
      }

      Caption {
        anchors.right: parent.right
        anchors.rightMargin: page.holdingRemoveWidth + page.gap + page.costWidth + page.gap
        text: "Quantity"
        font.pixelSize: Style.font.caption
      }

      Caption {
        anchors.right: parent.right
        anchors.rightMargin: page.holdingRemoveWidth + page.gap
        text: "Avg cost"
        font.pixelSize: Style.font.caption
      }
    }

    // One row per holding. The model is the count, not the list: saving
    // replaces the list (and the service re-reads the file after each write),
    // and rows rebuilt for that would lose the field being edited. Rows are
    // rebuilt only when holdings are added or removed.
    Repeater {
      id: holdingRows
      model: page.holdings.length

      Item {
        id: holdingRow
        required property int index
        readonly property var holding: page.holdings[index]
        readonly property var quote: holding ? page.quotes[holding.asset] : undefined
        // The currency the cost is in, once known (page.costCurrencyOf).
        readonly property string costCurrency: holding ? (page.costCurrencyOf(holding) || "") : ""

        function focusQuantity() {
          quantityField.forceActiveFocus()
          quantityField.selectAll()
        }

        width: column.width
        height: page.rowHeight + Style.space(6)

        Row {
          anchors.left: parent.left
          anchors.right: quantityField.left
          anchors.rightMargin: page.gap
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(4)

          Label {
            id: holdingLabel
            anchors.verticalCenter: parent.verticalCenter
            width: Math.min(implicitWidth, parent.width - holdingToggle.width - parent.spacing)
            text: holdingRow.holding ? PageLib.itemLabel(holdingRow.holding.asset, holdingRow.quote) : ""
            color: holdingRow.holding && holdingRow.holding.asset.indexOf("crypto:") === 0 ? Color.accent : page.fg
          }

          BarToggle {
            id: holdingToggle
            anchors.verticalCenter: parent.verticalCenter
            item: holdingRow.holding ? holdingRow.holding.asset : ""
          }
        }

        AmountField {
          id: quantityField
          anchors.right: costField.left
          anchors.rightMargin: page.gap
          anchors.verticalCenter: parent.verticalCenter
          width: page.quantityWidth
          holding: holdingRow.holding
          current: holdingRow.holding ? holdingRow.holding.quantity : 0
          onCommit: function(identity, value) { page.editHolding(identity, { quantity: value }) }
        }

        AmountField {
          id: costField
          anchors.right: holdingRemove.left
          anchors.rightMargin: page.gap
          anchors.verticalCenter: parent.verticalCenter
          width: page.costWidth
          current: holdingRow.holding ? holdingRow.holding.cost : 0
          prefix: holdingRow.costCurrency !== "" ? Format.currencyPrefix(holdingRow.costCurrency, page.base).trim() : ""
          menu: !page.locked
          holding: holdingRow.holding
          onCommit: function(identity, value) { page.editHolding(identity, { cost: value }) }
          onMenuRequested: costMenu.openFor(costField, holdingRow.holding, holdingRow.costCurrency || null)
        }

        RemoveButton {
          id: holdingRemove
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          enabled: !page.locked
          tooltipText: "Remove holding"
          onClicked: page.removeHolding(holdingRow.holding)
        }
      }
    }

    Caption {
      width: column.width
      topPadding: Style.space(4)
      visible: page.holdings.length > 0 && !page.locked
      text: "Avg cost is in the asset's own currency unless you change it with ▾. For cash, quantity is the amount and avg cost the rate you converted at."
    }

    Item { width: 1; height: Style.space(8); visible: !page.locked }

    SearchBox {
      id: holdingSearch
      visible: !page.locked
      placeholderText: "Add a holding: name or ticker"
      onPicked: function(result) { page.addHolding(result) }
    }

    // ---- Watchlist
    SectionTitle { text: "WATCHLIST" }

    Repeater {
      model: page.config.watch

      Item {
        id: watchRow
        required property string modelData
        readonly property var quote: page.quotes[modelData]
        width: column.width
        height: page.rowHeight

        Row {
          anchors.left: parent.left
          anchors.right: watchKind.left
          anchors.rightMargin: page.gap
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(4)

          Label {
            anchors.verticalCenter: parent.verticalCenter
            width: Math.min(implicitWidth, parent.width - watchToggle.width - parent.spacing)
            text: PageLib.itemLabel(watchRow.modelData, watchRow.quote)
            color: watchRow.modelData.indexOf("crypto:") === 0 ? Color.accent : page.fg
          }

          BarToggle {
            id: watchToggle
            anchors.verticalCenter: parent.verticalCenter
            item: watchRow.modelData
          }
        }

        Caption {
          id: watchKind
          anchors.right: watchRemove.left
          anchors.rightMargin: Style.space(4)
          anchors.verticalCenter: parent.verticalCenter
          wrapMode: Text.NoWrap
          text: watchRow.quote ? PageLib.kindLabel(watchRow.quote.kind) : ""
        }

        RemoveButton {
          id: watchRemove
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          tooltipText: "Stop watching"
          onClicked: page.persist({ watch: PageLib.withoutItem(page.config.watch, watchRow.modelData) })
        }
      }
    }

    Item { width: 1; height: Style.space(6) }

    SearchBox {
      id: watchSearch
      placeholderText: "Search to watch…"
      onPicked: function(result) {
        page.persist({ watch: PageLib.withItem(page.config.watch, result.asset) })
        watchSearch.clear()
      }
    }

    // ---- Data
    SectionTitle { text: "DATA" }

    Caption {
      width: column.width
      text: "Prices from Yahoo Finance and CoinGecko. Only ticker symbols are sent."
    }

    Item {
      width: column.width
      height: Math.max(pathText.implicitHeight, openFolder.implicitHeight) + Style.space(8)

      Caption {
        id: pathText
        anchors.left: parent.left
        anchors.right: openFolder.left
        anchors.rightMargin: page.gap
        anchors.verticalCenter: parent.verticalCenter
        wrapMode: Text.NoWrap
        elide: Text.ElideMiddle
        text: page.market ? PageLib.displayPath(page.market.holdingsPath, page.market.home) : ""
      }

      // Opens the folder for backups: xdg-open with the path as its argument,
      // no shell in between.
      Button {
        id: openFolder
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        text: "Open folder"
        bordered: true
        foreground: page.fg
        fontFamily: page.fontFamily
        fontSize: Style.font.bodySmall
        verticalPadding: Style.space(3)
        enabled: page.market !== null
        onClicked: Quickshell.execDetached(["xdg-open", PageLib.parentDir(page.market.holdingsPath)])
      }
    }
  }

  // Shown after a typed refresh interval was raised to the minimum.
  property bool refreshSnapped: false

  // Holdings column widths (mockup px, scaled with the shell's spacing).
  readonly property int quantityWidth: Style.space(72)
  readonly property int costWidth: Style.space(96)
  readonly property int holdingRemoveWidth: Style.space(20)
}
