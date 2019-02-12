import { Injectable } from '@angular/core';
import { ProjectService } from '../project/project.service';
import { PersistenceService } from '../../core/persistence/persistence.service';
import { RecurringConfig, Reminder, ReminderCopy, ReminderType } from './reminder.model';
import { SnackService } from '../../core/snack/snack.service';
import shortid from 'shortid';
import { NotifyService } from '../../core/notify/notify.service';
import { ReplaySubject, Subject } from 'rxjs';
import { debounce, throttle } from 'throttle-debounce';
import { promiseTimeout } from '../../util/promise-timeout';
import { dirtyDeepCopy } from '../../util/dirtyDeepCopy';

const WORKER_PATH = 'assets/web-workers/reminder.js';

@Injectable({
  providedIn: 'root',
})
export class ReminderService {
  public onReminderActive$ = new Subject<Reminder>();
  private _reminders$ = new ReplaySubject<Reminder[]>();
  public reminders$ = this._reminders$.asObservable();
  private _w: Worker;
  private _reminders: Reminder[];
  private _throttledShowNotification = throttle(60000, this._showNotification.bind(this));

  constructor(
    private readonly _projectService: ProjectService,
    private readonly _persistenceService: PersistenceService,
    private readonly _notifyService: NotifyService,
    private readonly _snackService: SnackService,
  ) {
  }

  async init() {
    if ('Worker' in window) {
      this._w = new Worker(WORKER_PATH);

      // we do this to wait for syncing and the like
      await promiseTimeout(1000 * 20);
      this._w.addEventListener('message', this._onReminderActivated.bind(this));
      this._w.addEventListener('error', this._handleError.bind(this));
      console.log('WORKER INITIALIZED FOR REMINDERS');


      await this.reloadFromLs();
    } else {
      console.error('No service workers supported :(');
    }
  }

  async reloadFromLs() {
    this._reminders = await this._loadFromLs() || [];
    this._saveModel(this._reminders);
  }

  getById(reminderId: string): ReminderCopy {
    const _foundReminder = this._reminders.find(reminder => reminder.id === reminderId);
    return _foundReminder && dirtyDeepCopy(_foundReminder);
  }

  addReminder(type: ReminderType, relatedId: string, title: string, remindAt: number, recurringConfig?: RecurringConfig): string {
    const id = shortid();
    this._reminders.push({
      id,
      projectId: this._projectService.currentId,
      relatedId,
      title,
      remindAt,
      type,
      recurringConfig
    });
    // this._persistenceService
    this._saveModel(this._reminders);
    return id;
  }

  updateReminder(reminderId: string, reminderChanges: Partial<Reminder>) {
    Object.assign(this.getById(reminderId), reminderChanges);
    this._saveModel(this._reminders);
  }

  removeReminder(reminderIdToRemove: string) {
    const i = this._reminders.findIndex(reminder => reminder.id === reminderIdToRemove);
    if (i > -1) {
      this._reminders.splice(i, 1);
      this._saveModel(this._reminders);
    } else {
      throw new Error('Unable to find reminder with id ' + reminderIdToRemove);
    }
  }

  private _onReminderActivated(msg: MessageEvent) {
    const reminder = msg.data as Reminder;
    // TODO get related model here
    this.onReminderActive$.next(reminder);
    this._throttledShowNotification(reminder);
  }

  private _showNotification(reminder: Reminder) {
    this._notifyService.notify({
      title: reminder.title,
    });
  }

  private async _loadFromLs(): Promise<Reminder[]> {
    return await this._persistenceService.loadReminders() || [];
  }

  private _saveModel(reminders: Reminder[]) {
    console.log('Reminder._saveModel', this._reminders);
    this._persistenceService.saveLastActive();
    this._persistenceService.saveReminders(reminders);
    this._updateRemindersInWorker(this._reminders);
    this._reminders$.next(this._reminders);
  }

  private _updateRemindersInWorker(reminders: Reminder[]) {
    this._w.postMessage(reminders);
  }

  private _handleError(err: any) {
    console.error(err);
    this._snackService.open({type: 'ERROR', message: 'Error for reminder interface'});
  }
}
