import {Area, OutputArea, LabContainer} from './areas';
import {ButtonGroup, CheckBox, Tabs} from './components';
import {Editor, EditorTheme} from './editor';
import {fetchBlob, DownloadRequest, DownloadResponse} from './comms';
import {ServerWorker} from './server';
import {Resource, RunProgram, CheckOutput} from './types';
import * as Strings from './strings';

enum DownloadType {
  None,
  Client,
  Server,
}

/** The Widget class */
export class Widget {
  private editors: Array<Editor> = [];
  protected readonly container: HTMLDivElement;
  private readonly name: string | null;
  private readonly switches: Array<string> = [];
  private tabs = new Tabs();
  protected outputArea = new OutputArea();

  protected buttons = new ButtonGroup();

  private readonly dlType: DownloadType = DownloadType.Client;

  private readonly server: string;

  private shadowFiles: Array<Resource> = [];
  protected outputGroup: HTMLDivElement | null = null;

  /**
   * Constructs the Widget
   * @param {HTMLDivElement} container - the container for the widget
   * @param {string} server - the server address:port
   */
  constructor(container: HTMLDivElement, server: string) {
    const resources: Array<Resource> = [];
    this.server = server;
    this.container = container;

    // Read attributes from container object to initialize members
    this.name = container.getAttribute('name');

    const files = this.container.getElementsByClassName('file');
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.hasAttribute('basename') || file.textContent == null) {
        throw Error('Malform widget: File doesnt have a name');
      }
      const a: Resource = {
        basename: file.getAttribute('basename') as string,
        contents: file.textContent,
      };
      resources.push(a);
    }

    if (resources.length == 0) {
      throw Error('Malformed widget: No files present.');
    }

    // Remove the files from the container since they are now editors
    while (files.length > 0) {
      this.container.removeChild(files[0]);
    }

    const shadowFiles = this.container.getElementsByClassName('shadow_file');
    for (let i = 0; i < shadowFiles.length; i++) {
      const file = shadowFiles[i];
      if (!file.hasAttribute('basename') || file.textContent == null) {
        throw Error('Malform widget: File doesnt have a name');
      }
      const a: Resource = {
        basename: file.getAttribute('basename') as string,
        contents: file.textContent,
      };
      this.shadowFiles.push(a);
    }

    // Remove the shadow files from the container since they are now a list
    while (shadowFiles.length > 0) {
      this.container.removeChild(shadowFiles[0]);
    }

    // fill the contents of the tabs
    resources.map((file) => {
      const ed = new Editor(file);
      this.editors.push(ed);

      const tab = this.tabs.addTab(file.basename, ed.render(), () => {
        const lengths = this.editors.map((e) => e.getLength());
        const max = Math.max(...lengths);
        ed.setLength(max);
      });
      ed.setTab(tab);
    });

    // Check which buttons are enabled on container and populate
    for (const mode in Strings.modeDictionary) {
      if (this.container.getAttribute(mode + '_button')) {
        this.buttons.addButton([],
            Strings.modeDictionary[mode].tooltip,
            Strings.modeDictionary[mode].buttonText,
            'click', async () => {
              await this.buttonCB(mode);
            });
      }
    }

    // if this widget doesn't have a name defined, don't allow for download
    if (this.name == null) {
      this.dlType = DownloadType.None;
    } else {
      // if there are any buttons, the dltype needs to be server
      if (this.buttons.length() > 0) {
        this.dlType = DownloadType.Server;
      } else {
        this.dlType = DownloadType.Client;
      }
    }

    // check for defined switches in attriburtes
    const swStr = this.container.getAttribute('switches');
    if (swStr) {
      this.switches = swStr.split(';');
    }
  }

  /**
   *  Method to destruct the object. Used primarily for testing.
   */
  public destructor(): void {
    for (const ed of this.editors) {
      ed.destructor();
    }
  }

  /**
   * Collect the resources loaded in the widget and return as list
   * @return {Array<Resource>} return the widget resources
   */
  protected collectResources(): Array<Resource> {
    const files: Array<Resource> = [];
    this.editors.map((e) => {
      files.push(e.getResource());
    });
    return files.concat(this.shadowFiles);
  }

  /**
   * Construct the server address string
   * @param {string} url - the url suffix
   * @return {string} - the full constructed url
   */
  private serverAddress(url: string): string {
    return this.server + '/' + url + '/';
  }

  /**
   * The main callback for the widget buttons
   * @param {string} mode - the mode of the button that triggered the event
   * @param {boolean} lab - specifies if this is a lab widget
   */
  protected async buttonCB(mode: string, lab = false): Promise<void> {
    this.outputArea.reset();

    // Clear any annotations added from previous button click
    this.editors.map((e) => {
      e.clearGutterAnnotation();
    });

    this.outputArea.add(['output_info', 'console_output'],
        Strings.CONSOLE_OUTPUT_LABEL + ':');
    this.outputArea.showSpinner(true);

    const files = this.collectResources();

    const serverData: RunProgram.TS = {
      files: files,
      mode: mode,
      switches: this.switches,
      name: this.name,
      lab: lab,
    };

    const worker = new ServerWorker(this.server,
        (data: CheckOutput.FS): number => {
          return this.processCheckOutput(data);
        });

    try {
      await worker.request(serverData, 'run_program');
    } catch (error) {
      this.outputArea.addError(Strings.MACHINE_BUSY_LABEL);
      console.error('Error:', error);
    } finally {
      this.outputArea.showSpinner(false);
    }
  }

  /**
   * The download example callback
   */
  private async downloadExample(): Promise<Array<DownloadResponse>> {
    const files: Array<Resource> = this.collectResources();
    const blobList: Array<DownloadResponse> = [];

    switch (this.dlType) {
      case DownloadType.None: {
        throw new Error('No download available for this exercise.');
      }
      case DownloadType.Server: {
        const serverData: DownloadRequest = {
          files: files,
          switches: this.switches,
          name: this.name,
        };

        const ret = await fetchBlob(serverData,
            this.serverAddress('download'));
        blobList.push(ret);

        break;
      }
      case DownloadType.Client: {
        this.editors.map((e): void => {
          const resource: Resource = e.getResource();

          blobList.push({
            blob: new Blob([resource.contents], {type: 'text/plain'}),
            filename: resource.basename,
          });
        });
        break;
      }
    }

    return blobList;
  }

  /**
   * Returns the correct Area to place data in
   * @param {number} ref - should be null for Widget
   * @return {Area} the area to place returned data
   */
  protected getHomeArea(ref: number): Area {
    if (ref != null) {
      throw new Error('Malformed data packet has ref in non-lab.');
    }
    return this.outputArea;
  }
  /**
   * Maps a basename to the corresponding editor
   *
   * @private
   * @param {string} basename - The basename to search for
   * @return {(Editor | null)} - Return the editor of null if not found
   */
  private basenameToEditor(basename: string): Editor | null {
    for (const e of this.editors) {
      if (basename === e.getResource().basename) {
        return e;
      }
    }

    return null;
  }

  /**
   * Handle the msg data coming back from server
   * @param {CheckOutput.RunMsg} msg - the returned msg
   * @param {Area} homeArea - the area to place the rendered msg
   */
  protected handleMsgType(msg: CheckOutput.RunMsg, homeArea: Area): void {
    switch (msg.type) {
      case 'console': {
        homeArea.addConsole(msg.data);
        break;
      }
      case 'internal_error':
        msg.data += ' ' + Strings.INTERNAL_ERROR_MESSAGE;
        // Intentional: fall through
      case 'stderr':
      case 'stdout': {
        // Split multiline messages into single lines for processing
        const outMsgList = msg.data.split(/\r?\n/);
        for (const outMsg of outMsgList) {
          const ctRegex = /^([a-zA-Z._0-9-]+):(\d+):(\d+):(.+)$/m;
          const rtRegex = /^raised .+ : ([a-zA-Z._0-9-]+):(\d+) (.+)$/m;
          const ctMatchFound = outMsg.match(ctRegex);
          const rtMatchFound = outMsg.match(rtRegex);
          // Lines that contain a sloc are clickable:
          const cb = (row: number, col: number, ed: Editor | null): void => {
            if (window.getSelection()?.toString() == '') {
              ed?.getTab()?.click();
              // Jump to corresponding line
              ed?.gotoLine(row, col);
            }
          };

          if (ctMatchFound?.length == 5) {
            const basename = ctMatchFound[1];
            const editor = this.basenameToEditor(basename);
            const row = parseInt(ctMatchFound[2]);
            const col = parseInt(ctMatchFound[3]);

            if (ctMatchFound[4].indexOf(' info:') === 0) {
              homeArea.addInfo(outMsg, () => {
                cb(row, col, editor);
              });
              editor?.setGutterAnnotation(row, col, outMsg, 'info');
            } else {
              if (ctMatchFound[4].indexOf(' warning:') === 0) {
                editor?.setGutterAnnotation(row, col, outMsg, 'warning');
              } else {
                editor?.setGutterAnnotation(row, col, outMsg, 'error');
              }
              homeArea.addMsg(outMsg, () => {
                cb(row, col, editor);
              });
            }
          } else if (rtMatchFound?.length == 4) {
            const basename = rtMatchFound[1];
            const editor = this.basenameToEditor(basename);
            const row = parseInt(rtMatchFound[2]);
            const col = 1;

            homeArea.addMsg(outMsg, () => {
              cb(row, col, editor);
            });
            editor?.setGutterAnnotation(row, col, outMsg, 'error');
          } else {
            homeArea.addLine(outMsg);
          }
        }
        break;
      }
      default: {
        homeArea.addLine(msg.data);
        throw new Error('Unhandled msg type.');
      }
    }
  }

  /**
   * Process the output from "check_output" ajax request
   * @param {CheckOutput.FS} data - The data from check_output
   * @return {number} the number of lines read by this function
   */
  private processCheckOutput(data: CheckOutput.FS): number {
    let readLines = 0;

    data.output.map((ol) => {
      const homeArea = this.getHomeArea(ol.ref);
      readLines++;

      this.handleMsgType(ol.msg, homeArea);
    });

    if (data.completed) {
      if (data.status != 0) {
        this.outputArea.addError(Strings.EXIT_STATUS_LABEL +
            ': ' + data.status);
      }
    }

    return readLines;
  }

  /**
   * Reset the editors, outputArea
   */
  protected resetEditors(): void {
    this.outputArea.reset();

    this.editors.map((e) => {
      e.reset();
    });
  }

  /**
   * Render the settings bar for the widget
   * @return {HTMLDivElement} the rendered settings bar
   */
  private renderSettingsBar(): HTMLDivElement {
    const settingsBar = document.createElement('div');
    settingsBar.classList.add('settings-bar');

    const dropdownContainer = document.createElement('div');
    dropdownContainer.classList.add('dropdown-container', 'settingsbar-item');
    settingsBar.appendChild(dropdownContainer);

    const dropdownButton = document.createElement('button');
    dropdownButton.classList.add('dropdown-btn');
    dropdownButton.innerHTML = '<i class="fas fa-cog"></i>';
    dropdownContainer.appendChild(dropdownButton);

    const dropdownContent = document.createElement('div');
    dropdownContent.classList.add('dropdown-content');
    dropdownContainer.appendChild(dropdownContent);

    const tabSetting =
        new CheckBox(Strings.SETTINGS_TABBED_EDITOR_LABEL, dropdownContent);
    tabSetting.getCheckBox().checked = true;
    tabSetting.getCheckBox().addEventListener('change', () => {
      if (tabSetting.checked()) {
        this.tabs.show(true);
      } else {
        this.tabs.show(false);
      }
    });

    const themeSetting =
        new CheckBox(Strings.SETTINGS_THEME_EDITOR_LABEL, dropdownContent);

    themeSetting.getCheckBox().addEventListener('change', () => {
      let theme = EditorTheme.Light;
      if (themeSetting.checked()) {
        theme = EditorTheme.Dark;
      }
      this.editors.map((e) => {
        e.setTheme(theme);
      });
    });

    const resetButton = document.createElement('button');
    resetButton.setAttribute('type', 'button');
    resetButton.classList.add('settingsbar-item', 'reset-btn');
    resetButton.setAttribute('title', Strings.RESET_TOOLTIP);
    resetButton.innerHTML = '<i class="fas fa-undo"></i>';
    settingsBar.appendChild(resetButton);
    resetButton.addEventListener('click', () => {
      if (window.confirm(Strings.RESET_CONFIRM_MSG)) {
        this.resetEditors();
      }
    });

    if (this.dlType != DownloadType.None) {
      const dlButton = document.createElement('button');
      dlButton.setAttribute('type', 'button');
      dlButton.classList.add('settingsbar-item', 'download-btn');
      dlButton.setAttribute('title', Strings.DOWNLOAD_TOOLTIP);
      dlButton.innerHTML = '<i class="fas fa-file-download"></i>';
      settingsBar.appendChild(dlButton);
      dlButton.addEventListener('click', async () => {
        try {
          const blobs = await this.downloadExample();

          for (const blob of blobs) {
            const objURL: string = URL.createObjectURL(blob.blob);

            const a = document.createElement('a');
            a.setAttribute('href', objURL);
            a.setAttribute('download', blob.filename);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            URL.revokeObjectURL(objURL);
          }
        } catch (error) {
          this.outputArea.reset();
          this.outputArea.addError(Strings.MACHINE_BUSY_LABEL);
          console.error('Error:', error);
        }
      });
    }

    return settingsBar;
  }

  /**
   * Render the widget by putting it into this.container
   */
  public render(): void {
    this.tabs.render(this.container);
    this.container.appendChild(this.renderSettingsBar());

    const row = document.createElement('div');
    row.classList.add('row', 'output_row');
    this.container.appendChild(row);

    row.appendChild(this.buttons.render());

    this.outputGroup = document.createElement('div');
    this.outputGroup.classList.add('col-md-9');
    this.outputGroup.appendChild(this.outputArea.render());
    row.appendChild(this.outputGroup);
  }
}

/**
 * The LabWidget class
 * @extends Widget
 */
export class LabWidget extends Widget {
  private readonly labContainer: LabContainer = new LabContainer;

  /**
   * Constructs the LabWidget
   * @param {HTMLDivElement} container - the container for the widget
   * @param {string} server - the server address:port
   */
  constructor(container: HTMLDivElement, server: string) {
    super(container, server);

    this.buttons.addButton([],
        Strings.modeDictionary['submit'].tooltip,
        Strings.modeDictionary['submit'].buttonText,
        'click', async () => {
          await this.buttonCB('submit');
        });
  }

  /**
   * The main callback for the widget buttons
   * @param {string} mode - the mode of the button that triggered the event
   * @param {boolean} lab - specifies that this is a lab
   */
  protected async buttonCB(mode: string, lab = true): Promise<void> {
    this.labContainer.reset();

    await super.buttonCB(mode, lab);

    this.labContainer.sort();
  }

  /**
   * Returns the correct Area to place data in
   * @param {number} ref - if not null, the lab ref
   * @return {Area} the area to place returned data
   */
  protected getHomeArea(ref: number): Area {
    if (ref != null) {
      return this.labContainer.getLabArea(ref);
    }
    return this.outputArea;
  }

  /**
   * Handle the msg data coming back from server
   * @param {CheckOutput.RunMsg} msg - the returned msg
   * @param {Area} homeArea - the area to place the rendered msg
   */
  protected handleMsgType(msg: CheckOutput.RunMsg, homeArea: Area): void {
    switch (msg.type) {
      case 'lab': {
        const result =
          this.labContainer.processResults(
              (msg.data as unknown) as CheckOutput.LabOutput);
        this.outputArea.addLabStatus(result);
        break;
      }
      default: {
        super.handleMsgType(msg, homeArea);
      }
    }
  }

  /**
   * Reset the editors, outputArea, and labContainer
   */
  protected resetEditors(): void {
    super.resetEditors();
    this.labContainer.reset();
  }

  /**
   * Render the widget by putting it into this.container
   */
  public render(): void {
    super.render();
    const lc = this.labContainer.render();
    this.outputGroup?.appendChild(lc);
  }
}

/**
 * Entrypoint for widget creation
 *
 * @export
 * @param {HTMLCollectionOf<Element>} widgets - The collection of widgets
 *    found on the page. This is the return value of getElementsByClass
 * @return {Array<Widget | LabWidget>} The list of widgets on the page
 */
export function widgetFactory(widgets: HTMLCollectionOf<Element>):
    Array<Widget | LabWidget> {
  const widgetList = [];
  for (let i = 0; i < widgets.length; i++) {
    const element = (widgets[i] as HTMLDivElement);
    const server = element.getAttribute('example_server');
    try {
      if (server) {
        const lab = element.getAttribute('lab');
        const widget =
            lab ? new LabWidget(element, server) : new Widget(element, server);
        widget.render();
        widgetList.push(widget);
      } else {
        throw Error('Malformed widget! No server address specified.');
      }
    } catch (error) {
      // an error has occured parsing the widget
      console.error('Error:', error);

      // clear the offending element to remove any processing that was done
      element.innerHTML = '';

      // add an error message to the page in its place
      const errorDiv = document.createElement('div');
      errorDiv.innerHTML = '<p>An error has occured processing this widget.' +
      Strings.INTERNAL_ERROR_MESSAGE + '</p>';

      element.appendChild(errorDiv);
    }
  }

  return widgetList;
}
