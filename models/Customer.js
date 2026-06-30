/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// Customer: synthetic customer account with only public-safe attributes.
	const Customer = sequelize.define('Customer', {
		CustomerId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the customer.'
		},
		CustomerCode: {
			type: DataTypes.STRING(20),
			allowNull: true,
			unique: true,
			comment: 'Synthetic customer code.'
		},
		CustomerName: {
			type: DataTypes.STRING(120),
			allowNull: true,
			comment: 'Synthetic customer display name.'
		},
		CustomerSegment: {
			type: DataTypes.STRING(40),
			allowNull: true,
			comment: 'Synthetic customer segment such as Retail, Wholesale, or Online.'
		},
		IsActive: {
			type: DataTypes.INTEGER(1),
			allowNull: false,
			defaultValue: '1',
			comment: 'Whether the synthetic customer is active.'
		}
	}, {
		tableName: 'Customer',
		timestamps: false,
		freezeTableName: true
	});

	Customer.associate = (models) => {
		Customer.hasMany(models.SalesDocument, { foreignKey: 'CustomerId', as: 'SalesDocuments' });
		Customer.hasMany(models.CustomerProductPrice, { foreignKey: 'CustomerId', as: 'CustomerProductPrices' });
	};

	return Customer;
};
