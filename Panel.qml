import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui
import "lib/panel.mjs" as PanelLib

// The popup under the bar widget. Two tabs:
// - Portfolio: the total, day move and unrealised gain over a chart of the
//   portfolio's value, then one row per holding.
// - Watchlist: one row per watched asset.
// Clicking a row (or j/k) turns the hero into that asset and highlights the row;
// "← Portfolio" or Esc goes back. The range picker (1D/1W/1M/3M/6M/1Y, opening on the
// `range` setting) drives the chart, the row sparklines and the rows' moves; history is asked of
// MarketService while the panel is open. The gear opens the settings page.
//
// Owns only view state (tab, selected row, range). What each line says comes
// from lib/panel.mjs; prices, history and health from the shared MarketService.
Panel {
  id: root
  moduleName: "bonavr.omafolio"
  // Hotkeys reach the panel through the bar (shell.toggle -> BarWidget.open).
  manageIpc: false

  // Handed over by BarWidget.injectPanel.
  property var anchorItem: null
  property var hostWidget: null
  property var market: null

  // The bar tracks the widget mounted in its slot, not this nested panel, so
  // everything that identifies the popout to the bar is that widget.
  readonly property var barIdentity: hostWidget || root

  // ---- Lifecycle

  function open() {
    resetView()
    setCenterHoverRevealSuppressed(false)
    root.controller.show()
  }

  function openFromHotkey() {
    resetView()
    root.controller.show()
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    settingsOpen = false
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function") return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // Summoning by hotkey moves no pointer, so a hover the bar was still holding
  // must not keep the center indicators revealed behind the panel.
  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function") root.bar.setCenterHoverRevealSuppressed(value)
  }

  // MarketService fetches history while any monitor's panel is showing; this
  // panel reports only its own state, to the service it last reported to.
  property var reportedOpenTo: null

  function reportOpen() {
    var service = opened ? market : null
    if (reportedOpenTo === service) return
    if (reportedOpenTo) reportedOpenTo.panelClosed(root)
    if (service) service.panelOpened(root)
    reportedOpenTo = service
  }

  onOpenedChanged: reportOpen()
  onMarketChanged: reportOpen()
  Component.onDestruction: if (reportedOpenTo) reportedOpenTo.panelClosed(root)

  // ---- View state

  // "portfolio" or "watchlist".
  property string tab: "portfolio"
  // Key (PanelRow.key) of the row shown in the hero instead of the tab's
  // overview; "" for the overview.
  property string selected: ""
  property string range: "1M"
  // Set by the gear. The settings page (SettingsPage.qml) replaces the body
  // once its Loader below has loaded it; it is created on every opening and
  // destroyed on closing.
  property bool settingsOpen: false
  onSettingsOpenChanged: scroller.contentY = 0

  // Hands the keyboard back to the panel once a settings field is done with it.
  function releaseFocus() {
    keyCatcher.forceActiveFocus()
  }
  readonly property bool settingsShown: settingsOpen && settingsLoader.status === Loader.Ready

  // Every open starts on the portfolio overview at the configured range.
  function resetView() {
    tab = "portfolio"
    selected = ""
    settingsOpen = false
    range = market ? market.config.range : "1M"
  }

  function showTab(name) {
    tab = name
    selected = ""
  }

  function select(key) {
    selected = selected === key ? "" : key
  }

  // Esc: settings page, then position view, then the panel.
  function back() {
    if (settingsShown) settingsOpen = false
    else if (selected !== "") selected = ""
    else close()
  }

  // h/l switch tabs; j/k step through the rows, showing each in the hero.
  function move(dx, dy) {
    if (settingsShown) return
    if (dx !== 0) {
      showTab(dx > 0 ? "watchlist" : "portfolio")
      return
    }
    if (rows.length === 0) return
    var at = indexOf(selected)
    var next = at < 0 ? (dy > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + dy))
    selected = rows[next].key
  }

  function indexOf(key) {
    for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return i
    return -1
  }

  // ---- What is shown (lib/panel.mjs)

  readonly property var panelData: market ? ({
    quotes: market.quotes,
    states: market.states,
    portfolio: market.portfolio,
    holdings: market.holdings,
    watch: market.config.watch,
    providerHealth: market.providerHealth,
    baseCurrency: market.config.baseCurrency,
    nativePrices: market.config.nativePrices,
    now: market.clock
  }) : null

  readonly property bool portfolioTab: tab === "portfolio"
  readonly property var rows: !panelData ? [] : (portfolioTab ? PanelLib.portfolioRows(panelData, seriesByAsset, range) : PanelLib.watchRows(panelData, seriesByAsset, range))
  // The selected row, while it is still in the list, and its asset.
  readonly property var shownRow: selected !== "" && indexOf(selected) >= 0 ? rows[indexOf(selected)] : null
  readonly property string shownAsset: shownRow ? shownRow.asset : ""

  // Cached history for everything on either tab; asking is what fetches it.
  readonly property var seriesByAsset: market && opened ? market.history(PanelLib.historyAssets(panelData, market.fx), range) : ({})

  readonly property var hero: {
    if (!panelData) return null
    if (shownRow) return PanelLib.assetHero(shownRow.asset, panelData, portfolioTab ? shownRow.key : null)
    return portfolioTab && panelData.holdings.length > 0 ? PanelLib.portfolioHero(panelData) : null
  }
  readonly property var chartSeries: {
    if (!panelData) return null
    if (shownAsset !== "") return seriesByAsset[shownAsset] || null
    return portfolioTab ? PanelLib.portfolioSeries(panelData, seriesByAsset, range) : null
  }
  readonly property var rangeInfo: PanelLib.rangeLine(chartSeries, range)
  readonly property var statusLines: panelData && shownAsset === "" ? PanelLib.statusLines(rows.map(function(r) { return r.asset }), panelData) : []

  // A sentence in place of (or above) the rows: unreadable holdings file, or an
  // empty tab.
  readonly property string notice: {
    if (!market) return ""
    if (portfolioTab) {
      if (market.holdingsError !== "") return market.holdingsError
      return market.holdings.length === 0 ? "No holdings yet. Add some in settings 󰒓" : ""
    }
    return rows.length === 0 ? "Watchlist empty. Add assets in settings 󰒓" : ""
  }

  // ---- Drawing

  ThemeColors {
    id: themeColors
  }

  readonly property string fontFamily: bar && bar.fontFamily ? bar.fontFamily : Style.font.family
  readonly property color fg: Color.popups.text
  readonly property color dim: Color.muted

  function moveColor(direction) {
    return direction === "up" ? themeColors.up : (direction === "down" ? themeColors.down : fg)
  }

  // Muted caption-sized text, the panel's secondary voice.
  component Caption: Text {
    textFormat: Text.PlainText
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    elide: Text.ElideRight
  }

  // A ⚠ that explains itself on hover.
  component Warning: Text {
    id: warning
    property string tip: ""
    visible: tip !== ""
    textFormat: Text.PlainText
    text: "⚠"
    color: root.fg
    font.family: root.fontFamily

    MouseArea {
      id: warningHover
      anchors.fill: parent
      anchors.margins: -Style.space(4)
      hoverEnabled: true
    }

    PanelToolTip {
      visible: warningHover.containsMouse
      text: warning.tip
      fontFamily: root.fontFamily
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    // The body sets its own 16/18 padding so a highlighted row can bleed into it.
    padding: 0
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(body.implicitHeight + 2 * root.padY)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.settingsShown && settingsLoader.item && settingsLoader.item.editing === true
      onCloseRequested: root.back()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) { root.move(dx, dy) }

      // Scrolls only when the screen is too short for the whole panel.
      Flickable {
        id: scroller
        anchors.fill: parent
        contentWidth: width
        contentHeight: body.implicitHeight + 2 * root.padY
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        ColumnLayout {
          id: body
          x: root.padX
          y: root.padY
          width: scroller.width - 2 * root.padX
          spacing: 0

          // ---- Tabs and gear
          Item {
            Layout.fillWidth: true
            implicitHeight: Math.max(tabs.implicitHeight, gear.implicitHeight)

            Row {
              id: tabs
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(4)
              visible: !root.settingsShown

              Repeater {
                model: [{ key: "portfolio", label: "Portfolio" }, { key: "watchlist", label: "Watchlist" }]

                Rectangle {
                  required property var modelData
                  readonly property bool active: root.tab === modelData.key
                  implicitWidth: tabText.implicitWidth + Style.space(20)
                  implicitHeight: tabText.implicitHeight + Style.space(6)
                  radius: Style.cornerRadius
                  color: active ? Style.selectedFillFor(root.fg, Color.accent)
                    : (tabHover.containsMouse ? Style.hoverFillFor(root.fg, Color.accent) : "transparent")

                  Text {
                    id: tabText
                    anchors.centerIn: parent
                    textFormat: Text.PlainText
                    text: parent.modelData.label
                    color: parent.active ? root.fg : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }

                  MouseArea {
                    id: tabHover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.showTab(parent.modelData.key)
                  }
                }
              }
            }

            Text {
              visible: root.settingsShown
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: "Settings"
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            PanelActionButton {
              id: gear
              anchors.right: parent.right
              anchors.rightMargin: -Style.space(4)
              anchors.verticalCenter: parent.verticalCenter
              iconText: root.settingsShown ? "󰅖" : "󰒓"
              tooltipText: root.settingsShown ? "Close settings" : "Settings"
              foreground: root.dim
              hoverColor: root.fg
              fontFamily: root.fontFamily
              onClicked: root.settingsOpen = !root.settingsOpen
            }
          }

          // The settings page (SettingsPage.qml).
          Loader {
            id: settingsLoader
            Layout.fillWidth: true
            Layout.topMargin: Style.space(16)
            active: root.settingsOpen
            visible: root.settingsShown
            source: Qt.resolvedUrl("SettingsPage.qml")
            onLoaded: item.panel = root
          }

          // ---- Hero
          ColumnLayout {
            Layout.fillWidth: true
            Layout.topMargin: Style.space(16)
            spacing: 0
            visible: !root.settingsShown && root.hero !== null

            Row {
              Layout.fillWidth: true
              spacing: 0

              Caption {
                id: backLink
                visible: root.shownAsset !== ""
                text: (root.portfolioTab ? "← Portfolio" : "← Watchlist") + " · "
                elide: Text.ElideNone

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.selected = ""
                }
              }

              Caption {
                width: Math.min(implicitWidth, parent.width - (backLink.visible ? backLink.width : 0))
                text: root.hero ? root.hero.title : ""
              }
            }

            Item {
              Layout.fillWidth: true
              implicitHeight: bigValue.implicitHeight

              Text {
                id: bigValue
                anchors.left: parent.left
                anchors.top: parent.top
                width: Math.min(implicitWidth, parent.width - heroChange.width - today.width - heroWarning.width - Style.space(27))
                textFormat: Text.PlainText
                text: root.hero ? root.hero.value : ""
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
                elide: Text.ElideRight
              }

              Text {
                id: heroChange
                anchors.left: bigValue.right
                anchors.leftMargin: Style.space(14)
                anchors.baseline: bigValue.baseline
                visible: root.hero !== null && root.hero.change !== ""
                textFormat: Text.PlainText
                text: root.hero ? root.hero.change : ""
                color: root.moveColor(root.hero ? root.hero.direction : "flat")
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }

              Caption {
                id: today
                anchors.left: heroChange.right
                anchors.leftMargin: Style.space(5)
                anchors.baseline: bigValue.baseline
                visible: heroChange.visible
                text: "today"
                font.pixelSize: Style.font.body
              }

              Warning {
                id: heroWarning
                anchors.left: heroChange.visible ? today.right : bigValue.right
                anchors.leftMargin: Style.space(8)
                anchors.baseline: bigValue.baseline
                font.pixelSize: Style.font.body
                tip: root.hero ? root.hero.tooltip : ""
              }
            }

            Row {
              Layout.fillWidth: true
              Layout.topMargin: Style.space(4)
              spacing: Style.space(8)
              visible: root.hero !== null && (root.hero.subLabel !== "" || root.hero.sub !== "")

              Caption {
                id: subLabel
                text: root.hero ? root.hero.subLabel : ""
                visible: text !== ""
              }

              Caption {
                width: Math.min(implicitWidth, parent.width - (subLabel.visible ? subLabel.width + parent.spacing : 0))
                text: root.hero ? root.hero.sub : ""
                color: root.moveColor(root.hero ? root.hero.subDirection : "flat")
              }
            }

            Item {
              Layout.fillWidth: true
              Layout.topMargin: Style.space(12)
              implicitHeight: Style.space(76)

              Sparkline {
                anchors.fill: parent
                points: root.chartSeries ? root.chartSeries.points : []
                color: root.moveColor(PanelLib.seriesDirection(root.chartSeries))
                filled: true
                lineWidth: 1.6
              }

              Caption {
                anchors.centerIn: parent
                visible: !root.chartSeries || root.chartSeries.points.length < 2
                text: root.panelData ? PanelLib.chartNote(root.panelData, root.seriesByAsset, root.shownAsset) : ""
              }
            }
          }

          // ---- Range picker, with the move over the range
          Item {
            Layout.fillWidth: true
            Layout.topMargin: root.hero !== null ? Style.space(8) : Style.space(16)
            implicitHeight: rangeRow.implicitHeight
            visible: !root.settingsShown && (root.hero !== null || root.rows.length > 0)

            Row {
              id: rangeRow
              anchors.left: parent.left
              anchors.leftMargin: -Style.space(7)
              spacing: Style.space(2)

              Repeater {
                model: ["1D", "1W", "1M", "3M", "6M", "1Y"]

                Item {
                  required property string modelData
                  readonly property bool active: root.range === modelData
                  implicitWidth: rangeText.implicitWidth + Style.space(14)
                  implicitHeight: rangeText.implicitHeight + Style.space(4)

                  Text {
                    id: rangeText
                    anchors.centerIn: parent
                    textFormat: Text.PlainText
                    text: parent.modelData
                    color: parent.active ? Color.accent : (rangeHover.containsMouse ? root.fg : root.dim)
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }

                  Rectangle {
                    visible: parent.active
                    anchors.bottom: parent.bottom
                    width: parent.width
                    height: Style.spacing.hairline
                    color: Color.accent
                  }

                  MouseArea {
                    id: rangeHover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.range = parent.modelData
                  }
                }
              }
            }

            Text {
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              visible: root.hero !== null
              width: Math.min(implicitWidth, parent.width - rangeRow.width)
              horizontalAlignment: Text.AlignRight
              textFormat: Text.PlainText
              text: root.rangeInfo.text
              color: root.moveColor(root.rangeInfo.direction)
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
            }
          }

          // ---- Market status (overview) or the asset's stats (position view)
          Repeater {
            model: root.settingsShown ? [] : root.statusLines

            Caption {
              required property string modelData
              Layout.fillWidth: true
              Layout.topMargin: Style.space(6)
              text: modelData
              wrapMode: Text.Wrap
              elide: Text.ElideNone
            }
          }

          GridLayout {
            Layout.fillWidth: true
            Layout.topMargin: Style.space(10)
            visible: !root.settingsShown && root.hero !== null && root.hero.details.length > 0
            columns: 3
            columnSpacing: Style.space(6)
            rowSpacing: Style.space(6)

            Repeater {
              model: root.hero ? root.hero.details : []

              Column {
                required property var modelData
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                spacing: Style.space(2)

                Caption {
                  width: parent.width
                  text: parent.modelData.label
                }

                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: parent.modelData.value
                  color: root.fg
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }
              }
            }

            // Keeps the three columns their width when there are fewer stats.
            Repeater {
              model: root.hero ? Math.max(0, 3 - root.hero.details.length) : 0
              Item { Layout.fillWidth: true; Layout.preferredWidth: 1 }
            }
          }

          Caption {
            Layout.fillWidth: true
            Layout.topMargin: Style.space(6)
            visible: !root.settingsShown && root.hero !== null && root.hero.asOf !== ""
            text: root.hero ? root.hero.asOf : ""
          }

          PanelSeparator {
            Layout.fillWidth: true
            Layout.topMargin: Style.space(12)
            Layout.bottomMargin: Style.space(6)
            foreground: root.fg
            visible: !root.settingsShown && (root.hero !== null || root.rows.length > 0)
          }

          Caption {
            Layout.fillWidth: true
            Layout.topMargin: Style.space(root.hero !== null || root.rows.length > 0 ? 4 : 16)
            Layout.bottomMargin: Style.space(4)
            visible: !root.settingsShown && root.notice !== ""
            text: root.notice
            wrapMode: Text.Wrap
            elide: Text.ElideNone
            color: root.market && root.market.holdingsError !== "" && root.portfolioTab ? root.fg : root.dim
          }

          // ---- Rows: asset | sparkline | value | day move
          Repeater {
            model: root.settingsShown ? [] : root.rows

            Rectangle {
              id: row
              required property var modelData
              readonly property bool current: root.shownRow !== null && modelData.key === root.shownRow.key
              Layout.fillWidth: true
              Layout.leftMargin: -root.rowBleed
              Layout.rightMargin: -root.rowBleed
              implicitHeight: label.implicitHeight + 2 * Style.space(7)
              radius: Style.cornerRadius
              color: current ? Style.hoverFillFor(root.fg, Color.accent)
                : (rowHover.containsMouse ? Style.normalFillFor(root.fg, Color.accent) : "transparent")

              // Accent edge on the highlighted row.
              Rectangle {
                visible: row.current
                width: Style.space(2)
                height: parent.height
                color: Color.accent
              }

              Text {
                id: label
                x: root.rowBleed
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(64)
                textFormat: Text.PlainText
                text: row.modelData.label
                color: row.modelData.crypto ? Color.accent : root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
              }

              Sparkline {
                id: spark
                anchors.left: label.right
                anchors.leftMargin: root.rowGap
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(50)
                height: Style.space(14)
                readonly property var series: root.seriesByAsset[row.modelData.asset] || null
                points: series ? series.points : []
                color: root.moveColor(PanelLib.seriesDirection(series))
              }

              // The row's own tooltip explains it.
              Text {
                id: rowWarning
                visible: row.modelData.tooltip !== ""
                anchors.right: value.right
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: "⚠"
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }

              Text {
                id: value
                anchors.left: spark.right
                anchors.leftMargin: root.rowGap
                anchors.right: change.left
                anchors.rightMargin: root.rowGap
                anchors.verticalCenter: parent.verticalCenter
                rightPadding: rowWarning.visible ? rowWarning.width + Style.space(4) : 0
                horizontalAlignment: Text.AlignRight
                textFormat: Text.PlainText
                text: row.modelData.value
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
              }

              Text {
                id: change
                anchors.right: parent.right
                anchors.rightMargin: root.rowBleed
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(64)
                horizontalAlignment: Text.AlignRight
                textFormat: Text.PlainText
                text: row.modelData.change
                color: root.moveColor(row.modelData.direction)
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
              }

              MouseArea {
                id: rowHover
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.select(row.modelData.key)
              }

              PanelToolTip {
                visible: rowHover.containsMouse && row.modelData.tooltip !== ""
                text: row.modelData.tooltip
                fontFamily: root.fontFamily
              }
            }
          }
        }
      }
    }
  }

  // ---- Metrics (mockup px, scaled with the shell's spacing)

  readonly property int padX: Style.space(18)
  readonly property int padY: Style.space(16)
  // Rows reach this far into the side padding, so the highlight has room
  // around the text.
  readonly property int rowBleed: Style.space(6)
  readonly property int rowGap: Style.space(10)
}
