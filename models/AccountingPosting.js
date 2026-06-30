/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// AccountingPosting: synthetic ledger posting fact tied to a sales document.
	const AccountingPosting = sequelize.define('AccountingPosting', {
		AccountingPostingId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the accounting posting row.'
		},
		SalesDocumentId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'SalesDocument', key: 'SalesDocumentId' },
			comment: 'Sales document represented by this posting.'
		},
		LedgerAccountId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'LedgerAccount', key: 'LedgerAccountId' },
			comment: 'Ledger account posted to by this row.'
		},
		PostingDate: {
			type: DataTypes.DATEONLY,
			allowNull: true,
			comment: 'Date when this posting was recorded.'
		},
		DebitAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Debit amount for this posting.'
		},
		CreditAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Credit amount for this posting.'
		}
	}, {
		tableName: 'AccountingPosting',
		timestamps: false,
		freezeTableName: true
	});

	AccountingPosting.associate = (models) => {
		AccountingPosting.belongsTo(models.SalesDocument, { foreignKey: 'SalesDocumentId', as: 'SalesDocument' });
		AccountingPosting.belongsTo(models.LedgerAccount, { foreignKey: 'LedgerAccountId', as: 'LedgerAccount' });
	};

	return AccountingPosting;
};
